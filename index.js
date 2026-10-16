/**
 * dsh-pi-bridge - DSH (DeepSeek Harness) entry: the host half of the plugin.
 *
 * Cordis contract: name, inject, apply(ctx, config). Installing a pi package
 * does NOT translate it: the package loads inside a supervised pi process, where
 * its ExtensionAPI, typebox, model registry, credentials and ctx.ui are pi's own.
 * DSH receives one thin forwarding tool per capability, so the package's code
 * never runs inside DSH and there is nothing for host semantics to drift on.
 * Skills are pure data (SKILL.md) and mount directly without running any code.
 *
 * Registry state lives under ~/.dsh-pi-bridge; nothing here writes into a DSH
 * profile. Only the tools service is required: everything else is acquired
 * through ctx.inject, so a profile without the skill registry loses that feature
 * rather than failing to load the plugin.
 *
 * @module index.js
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { installThroughProxy, loadIntoPi, callTool, listTools, materialize, ensureDaemon } from './src/proxy.js'
import { skillProviderFor } from './src/replay-dsh.js'
import { restoreIntoDsh } from './src/restore.js'
import { toToolSpec } from './src/schema.js'
import { loadDshBundle } from './src/dsh-loader.js'
import { startDshServer } from './src/serve.js'
import { projectResult } from './src/capabilities.js'
import { CACHE_ROOT } from './src/resolve.js'

export const name = 'dsh-pi-bridge'
export const inject = ['tools']

const REGISTRY_FILE = path.join(CACHE_ROOT, 'bridges.json')
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Where host-rewritten bundles are written: outside every published dir. */
const genDir = path.join(CACHE_ROOT, 'gen')

/**
 * Tool output in the shape the host's tools service validates directly.
 *
 * The host accepts an object root whose property values are value-schema
 * nodes; a required marker inside a property, or an object-level required
 * array, is rejected as unsupported. A real DSH boot proved this: an earlier
 * version carried per-property required flags and the entry never activated.
 */
const OUT = () => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      result: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: (value && value.result) || '' }],
})

/** Host tools answer through one guard: never throw into the agent loop. */
function guarded (fn) {
  return async (args) => {
    try { return { ok: true, result: String(await fn(args || {})) } }
    catch (e) { return { ok: false, result: 'dsh-pi-bridge: ' + message(e) } }
  }
}

/**
 * Build a tool definition without importing anything from the host.
 *
 * A bundle installed through the plugin manager is a symlink under the profile's
 * node_modules, so a bare specifier like '@deepseek-ai/dsh-tools' has no resolve
 * path from inside it and the import always fails; silently falling back then
 * handed the host an uncompiled schema. The host tools service takes a property
 * spec map and compiles it itself, so the bridge only has to hand it that shape.
 */
function defineHostTool (options) {
  return {
    ...options,
    parameters: toToolSpec(options.parameters),
    execute: options.execute,
  }
}

async function readRegistry () {
  try { return JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) } catch { return { bridges: {} } }
}

/**
 * Record this host's bridges without erasing the other host's.
 *
 * Both halves share one file. Writing our own snapshot back would drop an entry
 * the other host recorded while we were working, so merge over the newest copy on
 * disk. Removed keys are passed explicitly, because a plain merge would otherwise
 * resurrect an entry that bridge_remove just forgot.
 *
 * @param {any} state
 * @param {string[]} [removed]
 */
async function writeRegistry (state, removed) {
  await mkdir(CACHE_ROOT, { recursive: true })
  let merged = { bridges: {} }
  try { merged = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) } catch { /* first write */ }
  merged.bridges = merged.bridges || {}
  for (const [k, v] of Object.entries(state.bridges || {})) merged.bridges[k] = v
  for (const k of removed || []) delete merged.bridges[k]
  state.bridges = merged.bridges
  await writeFile(REGISTRY_FILE, JSON.stringify(merged, null, 2), 'utf8')
}

function defaultPrefix (spec) {
  const last = String(spec).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'bridged'
  const s = last
    .replace(/^@[^/]+\//, '')
    .replace(/^dsh-/, '')
    .replace(/^pi-/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
  return s || 'bridged'
}

function message (e) {
  return e && e.message ? String(e.message).slice(0, 400) : String(e)
}

function formatReport (spec, info, report) {
  const lines = ['bridged ' + spec + ((info && info.name) ? ' as ' + info.name + '@' + info.version : '')]
  lines.push('  mode: package code runs natively inside a supervised pi process')
  lines.push('  tools: ' + (report.tools.length ? report.tools.join(', ') : 'none'))
  lines.push('  skills mounted: ' + (report.skills.length ? report.skills.join(', ') : 'none'))
  if (report.commands.length) lines.push('  pi slash commands registered in pi: ' + report.commands.map(c => '/' + c).join(', '))
  if (report.skipped.length) lines.push('  reported by pi at load: ' + report.skipped.join('; '))
  if (!report.tools.length && !report.skills.length) {
    lines.push('  nothing callable arrived: the package likely needs pi-only surfaces')
  }
  lines.push('  Tools are callable now; other clients pick them up after a DSH restart.')
  return lines.join('\n')
}

/** Describe a package without registering anything in DSH. */
async function previewText (spec) {
  const m = await materialize(spec, {})
  const loaded = await loadIntoPi(m, {})
  const lines = [
    'package: ' + m.info.name + '@' + m.info.version,
    'detected: ' + JSON.stringify(m.info.signals),
    'dependencies: ' + (m.dependencies && m.dependencies.status) + ' (' + ((m.dependencies && m.dependencies.count) || 0) + ' declared)',
  ]
  for (const t of loaded.added || []) lines.push('  [tool] ' + t.name + ' - ' + String(t.description || '').slice(0, 110))
  for (const dir of m.skills || []) lines.push('  [skill] ' + path.basename(dir))
  for (const c of loaded.commands || []) lines.push('  [command in pi] /' + c.name)
  if (loaded.errors && loaded.errors.length) lines.push('  [load errors] ' + loaded.errors.join('; '))
  if (!(loaded.added || []).length && !(m.skills || []).length) {
    lines.push('  (no callable tool or skill arrived: this package probably depends on pi')
    lines.push('   UI or provider surfaces that cannot be reached from another host)')
  }
  return lines.join('\n')
}

export async function apply (ctx, config) {
  void config
  const tool = defineHostTool
  const state = await readRegistry()
  state.bridges = state.bridges || {}
  const log = (m) => { try { ctx.logger && ctx.logger.info && ctx.logger.info(m) } catch { /* ignore */ } }

  /**
   * A snapshot of the host services, read while this fiber is still active.
   *
   * ctx is a cordis Proxy that resolves a service out of the fiber's own store,
   * so reading ctx.tools from an async callback that outlived apply() throws
   * 'cannot get required service "tools" in inactive context' - measured on a
   * live boot, where the HTTP handler of the serve endpoint tried to load a
   * bundle and failed even though the identical call through the host's own tool
   * dispatch worked. Host tools are invoked inside an active fiber, which is why
   * dsh_install works and the server does not. Reading every service once, here,
   * gives the background path something stable to use.
   */
  const serviceSnapshot = {}
  for (const key of new Set(['tools', 'commands', 'skills', 'llm', 'sessions', 'settings', 'agent', 'workspace', 'subagents', 'events', 'logger'].concat(Object.keys(ctx || [])))) {
    try { const value = ctx[key]; if (value !== undefined) serviceSnapshot[key] = value } catch { /* not composed in this profile */ }
  }
  const serveScope = new Proxy(ctx, {
    get (target, prop) {
      if (prop in serviceSnapshot) return serviceSnapshot[prop]
      return target[prop]
    },
  })

  /**
   * Register one DSH forwarding tool per capability pi just loaded. Parameters
   * are the package's own schema; a call goes to pi and pi's native result comes
   * back, so what the model sees is pi's behaviour rather than a translation.
   */
  /**
   * Every tool this session loaded through the bridge, with the definition needed
   * to invoke it. Both dsh_install and the serve endpoint use it, so a tool the
   * user installed from the DSH chat is also callable from the other host - the
   * earlier split, where only /load recorded, left the server blind to installs
   * made through the tool (observed on a live boot: /tools answered []).
   */
  const hostCallable = new Map()

  /** Names this process registered, so a reinstall is a no-op rather than a clash. */
  const shellNames = new Set()
  function registerShells (prefix, tools, report) {
    for (const t of tools || []) {
      const name = prefix + '_' + t.name
      if (shellNames.has(name)) { report.tools.push(name); continue }
      shellNames.add(name)
      if (!ctx.tools || typeof ctx.tools.register !== 'function') { report.skipped.push('tools service missing; ' + name); continue }
      try {
        ctx.tools.register(tool({
          name,
          description: (t.description || '(no description)')
            + ' [dsh-pi-bridge: runs natively inside pi, from ' + (t.origin || 'pi') + ']',
          parameters: toToolSpec(t.parameters),
          output: OUT(),
          execute: async (args) => {
            const res = await callTool(t.name, args || {})
            if (!res || !res.ok) {
              return { ok: false, result: 'pi tool ' + t.name + ' failed: ' + ((res && res.error) || 'no result from pi') }
            }
            const projected = projectResult(res.result)
            return { ok: true, result: projected.text || JSON.stringify(projected.structured === undefined ? null : projected.structured) }
          },
        }))
        report.tools.push(name)
      } catch (e) {
        report.skipped.push('tool ' + name + ': ' + message(e))
      }
    }
  }

  /** Skills travel as data, so mount them straight from the cached package. */
  function mountSkills (dirs) {
    for (const dir of dirs || []) {
      if (!existsSync(path.join(dir, 'SKILL.md'))) continue
      ctx.inject(['skills'], (scope) => {
        if (scope && scope.skills && typeof scope.skills.registerProvider === 'function') {
          scope.skills.registerProvider(() => skillProviderFor(dir))
        }
      })
    }
  }

  /** Tools the bridge currently holds inside pi, for restores that re-added none. */
  async function bridgeTools () {
    const t = await listTools()
    return (t.tools || []).filter((x) => x.origin === 'bridge')
  }

  /** Install a pi package through the host-process proxy and record it. */
  async function installPi (spec, opts) {
    const prefix = (opts && opts.prefix) || defaultPrefix(spec)
    const { materialized, loaded } = await installThroughProxy(spec, { log, refresh: !!(opts && opts.refresh) })
    const report = { tools: [], commands: [], skills: [], events: [], skipped: [] }
    registerShells(prefix, loaded.added, report)
    if (loaded.errors && loaded.errors.length) report.skipped.push(...loaded.errors)
    for (const c of loaded.commands || []) report.commands.push(c.name)
    for (const dir of materialized.skills || []) report.skills.push(path.basename(dir))
    mountSkills(materialized.skills)
    state.bridges[spec] = {
      name: materialized.info.name,
      version: materialized.info.version,
      host: 'pi',
      mode: 'proxy',
      prefix,
      root: materialized.root,
      report,
      at: new Date().toISOString(),
    }
    await writeRegistry(state)
    return formatReport(spec, materialized.info, report)
  }

  const SOURCE = { type: 'string', required: true, description: 'Plugin source in pi grammar: npm:<pkg>[@ver], git:github.com/<owner>/<repo>[@ref], github:<owner>/<repo>, a URL, or a local path.' }
  const PREFIX = { type: 'string', description: 'Optional lowercase prefix for bridged tool names; defaults to the package name.' }

  ctx.tools.register(tool({
    name: 'pi_install',
    description: 'Install a pi coding agent package so its tools become callable from DSH. The package loads inside a supervised pi process and runs with the real pi ExtensionAPI, model registry, credentials and dependencies; DSH receives one forwarding tool per capability, so behaviour matches what a pi user sees. Accepts the same source string pi uses (npm:, git:, github:, URL, local path). Re-running reloads the package.',
    parameters: { source: SOURCE, prefix: PREFIX, refresh: { type: 'boolean', description: 'Re-download the source even when it is already in the bridge cache.' } },
    output: OUT(),
    execute: guarded(async (args) => installPi(args.source, args)),
  }))

  ctx.tools.register(tool({
    name: 'pi_preview',
    description: 'Inspect what a pi package would contribute before installing it: its tools with parameters, skill directories, pi slash commands, and whether its published dependencies installed. Loads the package into the pi host process but registers nothing in DSH.',
    parameters: { source: SOURCE },
    output: OUT(),
    execute: guarded(async (args) => previewText(args.source)),
  }))

  /**
   * Load another DSH bundle into this running host.
   *
   * Unlike the pi direction there is nothing to proxy: the bundle is applied
   * against this same live scope, so its tools are real host tools with real
   * ctx.services. The one obstacle is that a linked bundle cannot resolve bare
   * '@deepseek-ai/*' specifiers; dsh-loader rewrites those to the running
   * build's own modules (verified against a live DSH boot, where a bundle so
   * loaded registered a tool the model then called). A prefix is ignored here:
   * tool names belong to the bundle.
   */
  ctx.tools.register(tool({
    name: 'dsh_install',
    description: 'Load another DSH plugin bundle into this running DSH session, for a bundle the profile does not mount. The bundle is applied against the live host scope, so its tools use the real tools/llm/skills services; bare @deepseek-ai imports are resolved to the running build. Reports what it registered. Does not replace a bundle the profile already mounted.',
    parameters: { source: SOURCE, refresh: { type: 'boolean', description: 'Re-download the source even when cached.' } },
    output: OUT(),
    execute: guarded(async (args) => {
      const m = await materialize(args.source, { log, refresh: !!args.refresh })
      const loaded = await loadDshBundle(m.root, ctx, { genDir, log, registered: new Set(hostCallable.keys()) })
      if (loaded.error) throw new Error(loaded.error)
      for (const t of loaded.tools || []) {
        const def = loaded.callable && loaded.callable.get(t.name)
        if (def) hostCallable.set(t.name, { def, source: args.source })
      }
      const report = {
        tools: loaded.tools.map((t) => t.name),
        commands: loaded.commands.map((c) => c.name),
        skills: [],
        skipped: [],
        host: 'dsh',
      }
      state.bridges[args.source] = {
        name: loaded.name, version: m.info.version, host: 'dsh', mode: 'host-load',
        root: m.root, report, at: new Date().toISOString(),
      }
      await writeRegistry(state)
      const lines = ['loaded ' + loaded.name + '@' + m.info.version + ' into this DSH session']
      lines.push('  dependencies: ' + ((m.dependencies && m.dependencies.status) || 'n/a'))
      lines.push('  tools: ' + (report.tools.length ? report.tools.join(', ') : 'none'))
      lines.push('  commands: ' + (report.commands.length ? report.commands.map((c) => '/' + c).join(', ') : 'none'))
      if (loaded.mapped && loaded.mapped.length) lines.push('  host modules rewired: ' + loaded.mapped.join(', '))
      if (!report.tools.length && !report.commands.length) lines.push('  (the bundle registered nothing: it may be UI-only, or need a service this profile does not compose)')
      return lines.join('\n')
    }),
  }))

  ctx.tools.register(tool({
    name: 'bridge_list',
    description: 'List plugin bundles this bridge installed into DSH, with the tools and skills each contributed and whether they run through the pi host process.',
    parameters: {},
    output: OUT(),
    execute: guarded(async () => {
      const keys = Object.keys(state.bridges)
      if (!keys.length) return 'no bridged packages yet'
      return keys.map((k) => {
        const b = state.bridges[k]
        return '- ' + k + ' (' + b.name + '@' + b.version + ', mode=' + (b.mode || 'replay') + ') tools=' + (b.report.tools || []).join(',')
          + ' skills=' + (b.report.skills || []).join(',') + ' commands=' + (b.report.commands || []).join(',')
      }).join('\n')
    }),
  }))

  ctx.tools.register(tool({
    name: 'bridge_remove',
    description: 'Forget a bridged package and delete its cached copy. Tools already registered in this DSH process stay until restart; the bridge never unregisters host state behind your back.',
    parameters: { source: { ...SOURCE, description: 'The exact source string previously installed.' } },
    output: OUT(),
    execute: guarded(async (args) => {
      if (!state.bridges[args.source]) return 'not bridged: ' + args.source
      const entry = state.bridges[args.source]
      delete state.bridges[args.source]
      await writeRegistry(state, [args.source])
      const target = entry.root || entry.mirror
      if (target) await rm(target, { recursive: true, force: true })
      return 'removed ' + args.source + ' from the bridge registry (restart DSH to drop its registrations)'
    }),
  }))

  ctx.tools.register(tool({
    name: 'bridge_status',
    description: 'Report the pi host-process daemon behind the bridge: whether it is up, whether it captured an extension context, and which tools it holds. Check this before debugging a failed pi_install.',
    parameters: {},
    output: OUT(),
    execute: guarded(async () => {
      const h = await ensureDaemon({ log })
      const t = await listTools().catch(() => ({ tools: [] }))
      return JSON.stringify({
        daemon: { ok: !!(h && h.ok), ctxCaptured: !!(h && h.ctx), toolsInPi: h && h.tools },
        bridgeOwned: (t.tools || []).filter((x) => x.origin === 'bridge').map((x) => x.name),
        recorded: Object.keys(state.bridges).length,
      }, null, 1)
    }),
  }))

  // Two markers keep analysis side-effect free. A bridge that only wants to
  // know what a bundle registers (pi_preview, self-host checks, the other host
  // loading this one) must not start a pi daemon or bind a port: the bundle's
  // apply() runs here against a stand-in scope, so anything it launches would be
  // launched by an inspection.
  const capturing = process.env.DSH_PI_BRIDGE_CAPTURING === '1'

  // Reload recorded pi packages and remount their skills so an install survives a
  // restart. This uses the local cache only: host startup must never wait on a
  // network download, and a pruned cache reports itself instead of hanging.
  const replayable = { bridges: {} }
  // One bounded attempt: if the first bridge cannot start the daemon, the rest
  // would each pay the same wait, and DSH would sit there before its first answer.
  // null: untried. true: the daemon answered once, so later bridges may reuse it.
  // false: it failed, and repeating the wait per bridge would stall host startup.
  let daemonProved = null
  for (const [spec, entry] of Object.entries(state.bridges)) {
    if (entry.mode === 'proxy') {
      if (!entry.root || !existsSync(path.join(entry.root, 'package.json'))) {
        log('restore skipped ' + spec + ': cached package is gone')
        continue
      }
      if (capturing) {
        log('restore skipped ' + spec + ': inspecting this bundle, not loading it')
        continue
      }
      if (daemonProved === false) {
        log('restore skipped ' + spec + ': pi daemon unavailable')
        continue
      }
      try {
        const loaded = await loadIntoPi({ root: entry.root, dependencies: { status: 'installed' } }, { log, waitMs: 8000 })
        const report = { tools: [], commands: [], skills: [], events: [], skipped: [] }
        const tools = (loaded.added && loaded.added.length) ? loaded.added : await bridgeTools()
        registerShells(entry.prefix || defaultPrefix(spec), tools, report)
        mountSkills((entry.report && entry.report.skillDirs) || (entry.report && entry.report.skills) || [])
        daemonProved = true
        log('restored ' + spec + ': ' + report.tools.length + ' tool(s)')
      } catch (e) {
        daemonProved = false
        log('restore failed ' + spec + ': ' + message(e))
      }
    } else {
      replayable.bridges[spec] = entry
    }
  }

  const restore = (capturing || (config && config.restoreOnLoad === false))
    ? { restored: [], failed: [] }
    : await restoreIntoDsh(ctx, replayable, { log })
  if (restore.failed.length) {
    try { ctx.logger && ctx.logger.warn && ctx.logger.warn('dsh-pi-bridge restore: ' + restore.failed.join('; ')) } catch { /* ignore */ }
  }

  ctx.inject(['skills'], (scope) => {
    if (!scope || !scope.skills || typeof scope.skills.registerProvider !== 'function') return
    const selfSkill = path.join(HERE, 'skills', 'dsh-pi-bridge')
    if (existsSync(path.join(selfSkill, 'SKILL.md'))) scope.skills.registerProvider(() => skillProviderFor(selfSkill))
  })

  // ---- serve: let another host (pi) use DSH plugins from this live process ----
  // Off unless requested, so an ordinary DSH boot opens nothing. Handlers reuse
  // the same materialize/load path as dsh_install, so a bundle served to pi is
  // the same bundle the host would mount itself, with the host's real services.
  const servePort = capturing ? 0 : (Number(process.env.DSH_PI_BRIDGE_DSH_SERVE || 0) || (config && Number(config.servePort) || 0))
  if (servePort) {
    const handlers = {
      list: () => [...hostCallable.keys()],
      load: async (source) => {
        if (!source) throw new Error('no source given')
        const m = await materialize(source, { log })
        const r = await loadDshBundle(m.root, serveScope, { genDir, log, registered: new Set(hostCallable.keys()) })
        if (r.error) return { error: r.error, tools: [], commands: [] }
        // Tools the session already had are still exposed: they were registered by
        // the user's own dsh_install, and their definitions are in hostCallable.
        for (const n of r.reused || []) {
          const had = hostCallable.get(n)
          if (had) r.tools.push({ name: n, description: String((had.def && had.def.description) || ''), parameters: had.def && had.def.parameters })
        }
        for (const t of r.tools || []) {
          const def = r.callable && r.callable.get(t.name)
          if (def) hostCallable.set(t.name, { def, source })
        }
        return { tools: r.tools, commands: r.commands, name: r.name, version: m.info.version }
      },
      call: async (name, args) => {
        const entry = hostCallable.get(name)
        if (!entry) return { ok: false, error: 'not loaded in this DSH session: ' + name }
        if (typeof entry.def.execute !== 'function') return { ok: false, error: 'tool has no execute' }
        try {
          // The host passes a per-call execution object; a remote call has none, so
          // an empty one stands in. Tools that need host services beyond ctx will
          // report that themselves, and the caller sees a real error, not a fake ok.
          const out = await entry.def.execute(args || {}, { })
          return { ok: true, result: out }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e).slice(0, 300) }
        }
      },
    }
    const srv = startDshServer(servePort, handlers)
    if (srv) log('dsh-pi-bridge serving DSH plugins on 127.0.0.1:' + servePort)
    else log('dsh-pi-serve not started (port ' + servePort + ' unavailable)')
    ctx.tools.register(tool({
      name: 'dsh_serve_status',
      description: 'Report whether this DSH session is serving its plugins to another host, and which tools are currently exposed.',
      parameters: {},
      output: OUT(),
      execute: guarded(async () => JSON.stringify({ port: servePort, exposed: handlers.list() }, null, 1)),
    }))
  }

    log('dsh-pi-bridge loaded: ' + Object.keys(state.bridges).length + ' bridged package(s) on record')
}

export default { name, inject, apply }
