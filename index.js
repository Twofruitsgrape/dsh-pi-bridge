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
import { createDetachedScope } from './src/detached-scope.js'

export const name = 'dsh-pi-bridge'
export const inject = ['tools']

const REGISTRY_FILE = path.join(CACHE_ROOT, 'bridges.json')
const HERE = path.dirname(fileURLToPath(import.meta.url))

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
  const ownNames = new Set(['tools', 'commands', 'skills', 'llm', 'sessions', 'settings', 'agent', 'workspace', 'subagents', 'events', 'logger'].concat(Object.keys(ctx || [])))
  for (const key of ownNames) {
    try { const value = ctx[key]; if (value !== undefined) serviceSnapshot[key] = value } catch { /* not declared by this fiber */ }
  }
  /**
   * Names bundles asked for on live hosts, gathered from this session's own
   * refusals. The point of asking the host for each one is that this plugin
   * declares only 'tools', and a cordis scope refuses a service its fiber did not
   * declare - so a plain read of ctx.webServer says nothing about whether the
   * PROFILE composes webServer. ctx.inject([name], cb) is the one call that answers
   * that question honestly: the callback runs only when the name composes. Doing
   * it here, while apply() is running, is the only moment it can be done at all.
   *
   * Without this, a headless session told a GUI bundle that 'webServer' was not
   * composed and a snapshot-only view said the same thing for services the session
   * genuinely had, which is a refusal the user cannot act on.
   */
  const CANDIDATES = ['web', 'webServer', 'fs', 'sessionPersistence', 'credentials', 'connection', 'agentDefaultModel', 'model', 'channels', 'dialogs', 'prompt', 'gui', 'browser', 'typert', 'workspaceRegistry', 'sessionProjectionCache', 'http', 'profile', 'registry', 'hot', 'scopes', 'resolve', 'paths', 'jobs']
  for (const name of CANDIDATES) {
    if (serviceSnapshot[name] !== undefined) continue
    try {
      ctx.inject([name], (inner) => {
        try { const v = inner[name]; if (v !== undefined) serviceSnapshot[name] = v } catch { /* unreadable */ }
      })
    } catch { /* the profile does not compose it: leave it absent */ }
  }
    /**
   * The scope the serve endpoint mounts bundles into: the snapshot, detached from
   * any fiber. See src/detached-scope.js for the measurement that forced this.
   */
  const detachedScope = createDetachedScope(serviceSnapshot, { log })

  /**
   * Which fiber is this scope riding on, and is it still active?
   *
   * Under DSH_PI_BRIDGE_DEBUG=1 both load paths report this, plus a snapshot taken
   * here at apply time. The point is timing, not identity: both paths rode the same
   * fiber, and cordis' assertActive() fails only when that fiber's uid has become
   * null. Recording the state while apply()
   * is running and again when a request arrives is what distinguishes 'this
   * profile never composed the service' (what this bridge kept reporting) from
   * 'the bridge own fiber was disposed by the time the call arrived' - the frames
   * pointed at the latter, and the tool path is known to work in the same session.
   */
  const fiberState = (label, scope) => {
    if (process.env.DSH_PI_BRIDGE_DEBUG !== '1') return null
    const c = scope || ctx
    try {
      const f = c && c.fiber
      return label + ': uid=' + JSON.stringify(f && f.uid) + ' state=' + JSON.stringify(f && f.state)
        + ' inject=' + typeof (c && c.inject)
    } catch (e) { return label + ': read THREW ' + String((e && e.message) || e).slice(0, 70) }
  }
  // Only worth a log line when debugging; otherwise this prints on every boot.
  const fiberAtApply = fiberState('apply')
  if (fiberAtApply) log('bridge fiber at apply: ' + fiberAtApply)



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
  /** bundle identity -> what the first load registered, so a second is a no-op. */
  const loadedBundles = new Map()
  const bundleKey = (spec) => String(spec || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

  /**
   * Re-announce what a bundle already contributed instead of applying it twice.
   *
   * Reusing the cached module does not make a reload harmless: loadDshBundle
   * still calls apply(), and a second registration of the same service, prompt
   * section or tool name is what cordis rejects. On a live run this turned an
   * idempotent reinstall into "cannot load", and - worse - into an empty tool
   * list for a package whose tools were present in the session the whole time.
   *
   * @param {string} key
   * @returns {any|null}
   */
  /**
   * The lines every load report shares: what arrived, and why nothing did.
   *
   * Both branches - a fresh load and a recalled one - have to answer the same
   * question, and two copies of this text drift: the recalled branch was added
   * without the explanation of an empty result, so reinstalling a package that
   * contributes nothing said nothing about why.
   *
   * @param {any} summary { tools, commands, skills, mapped, reused, conflicts, deferred }
   */
  function formatLoaded (summary) {
    const tools = (summary.tools || []).map((t) => (t && t.name) || t)
    const cmds = (summary.commands || []).map((c) => (typeof c === 'string' ? c : '/' + (c && c.name)))
    const lines = []
    lines.push('  tools: ' + (tools.length ? tools.join(', ') : 'none'))
    lines.push('  commands: ' + (cmds.length ? cmds.join(', ') : 'none'))
    if (summary.skills) lines.push('  skill providers registered: ' + summary.skills)
    if (summary.mapped && summary.mapped.length) lines.push('  host modules rewired: ' + summary.mapped.join(', '))
    if (summary.reused && summary.reused.length) lines.push('  already registered in this session: ' + summary.reused.join(', '))
    for (const c of summary.conflicts || []) lines.push('  refused by the host: ' + c.name + ' (' + c.reason + ')')
    if (!tools.length && !cmds.length && !summary.skills) {
      // Two different situations both end with nothing registered. A bundle that
      // called ctx.inject is waiting for services this profile may not compose, so
      // its tools appear only once those exist - the fix is to mount the provider or
      // use the profile that ships them, not to reinstall.
      lines.push(summary.deferred
        ? '  (registered nothing yet: it asks for services through ctx.inject, and its tools appear once those services are composed - try the profile that ships them)'
        : '  (the bundle registered nothing at all: it is likely UI-only, configuration, or a host bridge)')
    }
    return lines
  }

  function recallBundle (key) {
    const prior = loadedBundles.get(key)
    if (!prior) return null
    const tools = prior.tools.filter((t) => hostCallable.has(t.name))
    return { ...prior, tools, reused: tools.map((t) => t.name), alreadyLoaded: true }
  }

  /** Names this process registered, so a reinstall is a no-op rather than a clash. */
  const shellNames = new Set()
  function registerShells (prefix, tools, report) {
    for (const t of tools || []) {
      const name = prefix + '_' + t.name
      if (shellNames.has(name)) { report.tools.push(name); continue }
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
        // Remembered only on success: a name the host refused is not ours, and
        // marking it as registered would make a later retry report it as live.
        shellNames.add(name)
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
      const key = bundleKey(args.source)
      const m = await materialize(args.source, { log, refresh: !!args.refresh })
      if (!args.refresh) {
        const recalled = recallBundle(key)
        if (recalled) {
          state.bridges[args.source] = { ...(state.bridges[args.source] || {}), name: recalled.name, mode: 'host-load', root: m.root, at: new Date().toISOString() }
          await writeRegistry(state)
          return ['loaded ' + recalled.name + '@' + (recalled.version || m.info.version) + ' (already loaded in this session)']
            .concat(['  dependencies: ' + ((m.dependencies && m.dependencies.status) || 'n/a')], formatLoaded(recalled)).join('\n')
        }
      }
      // The host invokes a tool on an active fiber, so the plugin's own ctx works
      // here and is what live sessions have loaded bundles with (dsh-mnemon: 17
      // tools). It is NOT valid on the serve path, whose callback runs after this
      // plugin's fiber has been disposed - measured as uid=78 at apply, uid=null
      // at request - and that mount uses the detached snapshot scope instead.
      const loaded = await loadDshBundle(m.root, ctx, { cacheRoot: CACHE_ROOT, log, registered: new Set(hostCallable.keys()) })
      if (loaded.error) {
        const where = fiberState('tool-path-after-load', ctx)
        throw new Error(loaded.error + (where ? ' [' + where + ']' : ''))
      }
      for (const t of loaded.tools || []) {
        const def = loaded.callable && loaded.callable.get(t.name)
        if (def) hostCallable.set(t.name, { def, source: args.source })
      }
      loadedBundles.set(key, { name: loaded.name, version: m.info.version, tools: loaded.tools, commands: loaded.commands, skills: loaded.skills })
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
      const lines = ['loaded ' + loaded.name + '@' + m.info.version + ' into this DSH session',
        '  dependencies: ' + ((m.dependencies && m.dependencies.status) || 'n/a')]
        .concat(formatLoaded(loaded))
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
        let scopeProbe = [fiberAtApply, fiberState('detached', detachedScope), fiberState('bridge-ctx', ctx)].filter(Boolean).join(' | ')
        // Does ctx.inject on the root scope actually run its callback? The mount
        // now passes assertActive (root fiber is uid=0 ACTIVE) but the loader
        // reported 'registrations would go nowhere', which is this bridge's wording
        // for "the callback never ran". Ask directly, with the simplest possible
        // service, and record what the handle does: awaiting it should settle the
        // child fiber, and the flag says whether apply-equivalent executed. Without
        // this the next guess would be a fourth wrong one.
        if (process.env.DSH_PI_BRIDGE_DEBUG === '1') {
          const probe = { ran: false, handle: 'none', awaited: 'not-awaited', direct: 'n/a' }
          try {
            probe.direct = typeof detachedScope.tools
            const h = detachedScope.inject(['tools'], () => { probe.ran = true })
            probe.handle = h === undefined ? 'undefined' : typeof h
            if (h && typeof h.then === 'function') {
              probe.awaited = await Promise.race([
                h.then(() => 'settled', (e) => 'rejected: ' + String((e && e.message) || e).slice(0, 70)),
                new Promise((r) => setTimeout(() => r('TIMEOUT 3000ms'), 3000)),
              ])
            }
          } catch (e) { probe.error = String((e && e.message) || e).slice(0, 120) }
          scopeProbe += ' || inject-probe: ran=' + probe.ran + ' handle=' + probe.handle + ' awaited=' + probe.awaited
            + ' tools=' + probe.direct + (probe.error ? ' threw=' + probe.error : '')
        }
        const key = bundleKey(source)
        const m = await materialize(source, { log })
        const recalled = recallBundle(key)
        if (recalled) return { ok: true, ...recalled, error: undefined }
        const r = await loadDshBundle(m.root, detachedScope, { cacheRoot: CACHE_ROOT, log, registered: new Set(hostCallable.keys()) })
        // Carry every diagnostic the loader produced. This line used to rebuild a
        // minimal { error, tools, commands } object, which silently dropped the
        // debug stack the loader had been asked to capture - so a session run with
        // DSH_PI_BRIDGE_DEBUG=1 still reported '(none)' and the refusal stayed
        // unexplained. Pass the result through instead of curating it here.
        if (r.error) {
          // A bundle that failed inside its own apply() may still have registered
          // tools before it threw. Emptying the list here would hide a real
          // half-load and make the report read like "this package has nothing";
          // a refusal to mount at all has nothing registered, so the distinction
          // the loader draws (bundleError) is exactly the one worth keeping.
          if (r.bundleError) return { ...r, scopeProbe }
          return { ...r, tools: [], commands: [], skills: 0, scopeProbe }
        }
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
        loadedBundles.set(key, { name: r.name, version: m.info.version, tools: r.tools, commands: r.commands, skills: r.skills })
        return { tools: r.tools, commands: r.commands, skills: r.skills, reused: r.reused, name: r.name, version: m.info.version }
      },
      call: async (name, args) => {
        const entry = hostCallable.get(name)
        if (!entry) return { ok: false, error: 'not loaded in this DSH session: ' + name }
        if (typeof entry.def.execute !== 'function') return { ok: false, error: 'tool has no execute' }
        try {
          // The host hands a tool an execution context (callId, signal, and the
          // calling agent's scope). A remote HTTP call has no agent turn behind it,
          // and agent must not be fabricated: a tool that dispatches subagents or
          // writes session state under a fake identity is worse than one that
          // refuses. So this carries what is genuinely available - an identity for
          // the call and a real abort signal - and leaves agent undefined, so a
          // tool's own guard produces its own clear message ('requires a live DSH
          // agent', measured) instead of a TypeError from reading exec.signal.
          const controller = new AbortController()
          const exec = {
            callId: 'dsh-pi-bridge:' + name + ':' + Date.now().toString(36),
            name,
            arguments: args || {},
            signal: controller.signal,
            agent: undefined,
          }
          const timer = setTimeout(() => controller.abort(), 120000)
          let out
          try { out = await entry.def.execute(args || {}, exec) }
          finally { clearTimeout(timer) }
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
