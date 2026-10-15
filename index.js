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
import { loadForeign } from './src/load.js'
import { replayIntoDsh, skillProviderFor } from './src/replay-dsh.js'
import { restoreIntoDsh } from './src/restore.js'
import { toToolSpec } from './src/schema.js'
import { projectResult } from './src/capabilities.js'
import { CACHE_ROOT } from './src/resolve.js'

export const name = 'dsh-pi-bridge'
export const inject = ['tools']

const REGISTRY_FILE = path.join(CACHE_ROOT, 'bridges.json')
const HERE = path.dirname(fileURLToPath(import.meta.url))

const OUT = () => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { type: 'string', required: true },
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

/** The host defineTool when the profile composes dsh-tools; a stand-in otherwise. */
async function toolCompiler () {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
  } catch { /* host without the tools package (offline self-test) */ }
  const { specToJsonSchema } = await import('./src/schema.js')
  return (options) => ({ ...options, parameters: specToJsonSchema(options.parameters) })
}

async function readRegistry () {
  try { return JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) } catch { return { bridges: {} } }
}

async function writeRegistry (state) {
  await mkdir(CACHE_ROOT, { recursive: true })
  await writeFile(REGISTRY_FILE, JSON.stringify(state, null, 2), 'utf8')
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
  const tool = await toolCompiler()
  const state = await readRegistry()
  state.bridges = state.bridges || {}
  const log = (m) => { try { ctx.logger && ctx.logger.info && ctx.logger.info(m) } catch { /* ignore */ } }

  /**
   * Register one DSH forwarding tool per capability pi just loaded. Parameters
   * are the package's own schema; a call goes to pi and pi's native result comes
   * back, so what the model sees is pi's behaviour rather than a translation.
   */
  function registerShells (prefix, tools, report) {
    for (const t of tools || []) {
      const name = prefix + '_' + t.name
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

  ctx.tools.register(tool({
    name: 'dsh_install',
    description: 'Load another DSH plugin bundle into this DSH session through the bridge, for a bundle the profile does not mount. Same-host loading, so registrations replay directly; it does not replace a bundle the profile already installed.',
    parameters: { source: SOURCE, prefix: PREFIX },
    output: OUT(),
    execute: guarded(async (args) => {
      const captured = await loadForeign(args.source, { host: 'dsh', log })
      const prefix = args.prefix || defaultPrefix(args.source)
      const report = await replayIntoDsh(ctx, captured, { prefix })
      state.bridges[args.source] = { name: captured.info.name, version: captured.info.version, host: 'dsh', mode: 'replay', prefix, mirror: captured.mirror, report, at: new Date().toISOString() }
      await writeRegistry(state)
      return formatReport(args.source, captured.info, report)
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
      await writeRegistry(state)
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

  // Reload recorded pi packages and remount their skills so an install survives a
  // restart. This uses the local cache only: host startup must never wait on a
  // network download, and a pruned cache reports itself instead of hanging.
  const replayable = { bridges: {} }
  for (const [spec, entry] of Object.entries(state.bridges)) {
    if (entry.mode === 'proxy') {
      if (!entry.root || !existsSync(path.join(entry.root, 'package.json'))) {
        log('restore skipped ' + spec + ': cached package is gone')
        continue
      }
      try {
        const loaded = await loadIntoPi({ root: entry.root, dependencies: { status: 'installed' } }, { log })
        const report = { tools: [], commands: [], skills: [], events: [], skipped: [] }
        const tools = (loaded.added && loaded.added.length) ? loaded.added : await bridgeTools()
        registerShells(entry.prefix || defaultPrefix(spec), tools, report)
        mountSkills((entry.report && entry.report.skillDirs) || (entry.report && entry.report.skills) || [])
        log('restored ' + spec + ': ' + report.tools.length + ' tool(s)')
      } catch (e) {
        log('restore failed ' + spec + ': ' + message(e))
      }
    } else {
      replayable.bridges[spec] = entry
    }
  }

  const restore = (config && config.restoreOnLoad === false)
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

  log('dsh-pi-bridge loaded: ' + Object.keys(state.bridges).length + ' bridged package(s) on record')
}

export default { name, inject, apply }
