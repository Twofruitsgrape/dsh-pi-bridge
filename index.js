/**
 * dsh-pi-bridge — DSH (DeepSeek Harness) entry: the host half of the plugin.
 *
 * Cordis plugin contract: name, inject, apply(ctx, config). The plugin exposes
 * the cross-host installer as DSH tools, so an agent — or the user through the
 * tool — can install pi packages into the running DSH, preview what a package
 * would provide before installing, and forget bridges again. Registry state
 * lives under ~/.dsh-pi-bridge; nothing here writes into DSH's own profile, so
 * uninstalling the bridge leaves the profile as it was.
 *
 * Services are acquired with ctx.inject rather than a static inject list for
 * everything except tools: a profile that composes without the skills registry
 * loses skill mounting, not the whole plugin.
 *
 * @module index.js
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { loadForeign } from './src/load.js'
import { replayIntoDsh, skillProviderFor } from './src/replay-dsh.js'
import { CACHE_ROOT } from './src/resolve.js'
import { restoreIntoDsh } from './src/restore.js'

export const name = 'dsh-pi-bridge'
/** tools is the only hard requirement; the rest degrades through ctx.inject. */
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

/** Every host tool answers through one guard: never throw into the agent loop. */
function guarded (fn) {
  return async (args) => {
    try { return { ok: true, result: String(await fn(args || {})) } }
    catch (e) { return { ok: false, result: 'dsh-pi-bridge: ' + message(e) } }
  }
}

/** Host defineTool when the profile composes dsh-tools; a faithful fallback otherwise. */
async function toolCompiler () {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
  } catch { /* host without the tools package (self-test) */ }
  const { specToJsonSchema } = await import('./src/schema.js')
  return (options) => ({
    ...options,
    parameters: specToJsonSchema(options.parameters),
    execute: async (args, exec) => options.execute(args, exec),
  })
}

async function readRegistry () {
  try { return JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) } catch { return { bridges: {} } }
}

async function writeRegistry (state) {
  await mkdir(CACHE_ROOT, { recursive: true })
  await writeFile(REGISTRY_FILE, JSON.stringify(state, null, 2), 'utf8')
}

function defaultPrefix (name) {
  const s = String(name)
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

function formatReport (spec, captured, report) {
  const lines = ['bridged ' + spec + ' as ' + captured.info.name + '@' + captured.info.version]
  lines.push('  tools: ' + (report.tools.length ? report.tools.join(', ') : 'none'))
  lines.push('  commands: ' + (report.commands.length ? report.commands.map(c => '/' + c).join(', ') : 'none'))
  lines.push('  skills: ' + (report.skills.length ? report.skills.join(', ') : 'none'))
  if (report.events.length) lines.push('  events: ' + report.events.join(', '))
  if (report.skipped.length) lines.push('  skipped: ' + report.skipped.join('; '))
  if (captured.errors && captured.errors.length) lines.push('  load errors: ' + captured.errors.join('; '))
  lines.push('  Tools are callable now. On the next DSH start they are replayed from the bridge cache, so the install persists; other clients pick them up then.')
  return lines.join('\n')
}

async function previewText (captured) {
  const lines = ['package: ' + captured.info.name + '@' + captured.info.version, 'detected: ' + JSON.stringify(captured.info.signals)]
  for (const cap of captured.capabilities || []) lines.push('  [' + cap.kind + '] ' + cap.name + ' - ' + String(cap.description || '').slice(0, 100))
  for (const dir of captured.skillDirs || []) lines.push('  [skill-dir] ' + dir)
  for (const e of captured.events || []) lines.push('  [event] ' + e.event)
  for (const u of captured.unsupported || []) lines.push('  [unsupported] ' + u)
  for (const err of captured.errors || []) lines.push('  [error] ' + err)
  if (!(captured.capabilities || []).length && !(captured.skillDirs || []).length) lines.push('  (nothing registrable found - the bundle may need host services the bridge cannot stand in for)')
  return lines.join('\n')
}

export async function apply (ctx, config) {
  void config
  const tool = await toolCompiler()
  const state = await readRegistry()
  state.bridges = state.bridges || {}
  const log = (m) => { try { ctx.logger && ctx.logger.info && ctx.logger.info(m) } catch { /* ignore */ } }

  /** Install one pi package as DSH capabilities and record it. */
  async function installPi (spec, opts) {
    const captured = await loadForeign(spec, { host: 'pi', refresh: !!(opts && opts.refresh), log })
    const prefix = (opts && opts.prefix) || defaultPrefix(captured.info.name)
    const report = await replayIntoDsh(ctx, captured, { prefix })
    state.bridges[spec] = {
      name: captured.info.name,
      version: captured.info.version,
      host: 'pi',
      prefix,
      mirror: captured.mirror,
      report,
      at: new Date().toISOString(),
    }
    await writeRegistry(state)
    return formatReport(spec, captured, report)
  }

  const SOURCE = { type: 'string', required: true, description: 'Plugin source in pi grammar: npm:<pkg>[@ver], git:github.com/<owner>/<repo>[@ref], github:<owner>/<repo>, a URL, or a local path.' }
  const PREFIX = { type: 'string', description: 'Optional lowercase prefix for bridged names; defaults to the package name.' }

  ctx.tools.register(tool({
    name: 'pi_install',
    description: 'Install a pi coding agent package into this DSH session as native DSH tools, slash commands and skills. It resolves the source, compiles its TypeScript to ESM, loads it against a recording host, and replays what it registers onto DSH. Accepts the same source string pi would use. Re-running reloads the package.',
    parameters: {
      source: SOURCE,
      prefix: PREFIX,
      refresh: { type: 'boolean', description: 'Re-download the source even when it is already in the bridge cache.' },
    },
    output: OUT(),
    execute: guarded(async (args) => installPi(args.source, args)),
  }))

  ctx.tools.register(tool({
    name: 'pi_preview',
    description: 'Inspect what a pi package would provide before installing it: the tools, commands, skills and events it registers, plus anything the bridge cannot carry over. Loads the package into the cache without touching the session.',
    parameters: { source: SOURCE },
    output: OUT(),
    execute: guarded(async (args) => previewText(await loadForeign(args.source, { host: 'pi', log }))),
  }))

  ctx.tools.register(tool({
    name: 'dsh_install',
    description: 'Load another DSH plugin bundle into this session through the bridge, for a bundle the profile does not mount. Inspects the bundle manifest, records its registrations and replays them; it does not replace a bundle the profile already installed.',
    parameters: { source: SOURCE, prefix: PREFIX },
    output: OUT(),
    execute: guarded(async (args) => {
      const captured = await loadForeign(args.source, { host: 'dsh', log })
      const prefix = (args.prefix) || defaultPrefix(captured.info.name)
      const report = await replayIntoDsh(ctx, captured, { prefix })
      state.bridges[args.source] = { name: captured.info.name, version: captured.info.version, host: 'dsh', prefix, mirror: captured.mirror, report, at: new Date().toISOString() }
      await writeRegistry(state)
      return formatReport(args.source, captured, report)
    }),
  }))

  ctx.tools.register(tool({
    name: 'bridge_list',
    description: 'List plugin bundles this bridge installed into DSH, with the tools, commands and skills each contributed.',
    parameters: {},
    output: OUT(),
    execute: guarded(async () => {
      const keys = Object.keys(state.bridges)
      if (!keys.length) return 'no bridged packages yet'
      return keys.map(k => {
        const b = state.bridges[k]
        return '- ' + k + ' (' + b.name + '@' + b.version + ', host=' + b.host + ') tools=' + (b.report.tools || []).join(',') + ' commands=' + (b.report.commands || []).join(',') + ' skills=' + (b.report.skills || []).length
      }).join('\n')
    }),
  }))

  ctx.tools.register(tool({
    name: 'bridge_remove',
    description: 'Forget a bridged package and delete its mirror build from the bridge cache. Registrations already made in this process stay until DSH restarts.',
    parameters: { source: { ...SOURCE, description: 'The exact source string previously installed.' } },
    output: OUT(),
    execute: guarded(async (args) => {
      if (!state.bridges[args.source]) return 'not bridged: ' + args.source
      const entry = state.bridges[args.source]
      delete state.bridges[args.source]
      await writeRegistry(state)
      if (entry.mirror) await rm(entry.mirror, { recursive: true, force: true })
      return 'removed ' + args.source + ' from the bridge registry (restart DSH to drop its registrations)'
    }),
  }))

  // Skills from previously recorded bridges remount on every plugin load.
  ctx.inject(['skills'], (scope) => {
    if (!scope || !scope.skills || typeof scope.skills.registerProvider !== 'function') return
    for (const entry of Object.values(state.bridges)) {
      for (const dir of (entry.report && entry.report.skills) || []) {
        if (existsSync(path.join(dir, 'SKILL.md'))) scope.skills.registerProvider(() => skillProviderFor(dir))
      }
    }
    // The bridge's own skill, so users find the workflow from the skill list.
    const selfSkill = path.join(HERE, 'skills', 'dsh-pi-bridge')
    if (existsSync(path.join(selfSkill, 'SKILL.md'))) scope.skills.registerProvider(() => skillProviderFor(selfSkill))
  })

  // Replay recorded pi packages so an install survives a restart instead of
  // living one session. Disabled with { restoreOnLoad: false } in bundle config.
  const restore = (config && config.restoreOnLoad === false) ? { restored: [], failed: [] } : await restoreIntoDsh(ctx, state, { log })
  if (restore.failed.length) { try { ctx.logger && ctx.logger.warn && ctx.logger.warn('dsh-pi-bridge restore: ' + restore.failed.join('; ')) } catch { /* ignore */ } }

  const count = Object.keys(state.bridges).length
  log('dsh-pi-bridge loaded: ' + count + ' bridged package(s) on record, ' + restore.restored.length + ' replayed')
}

export default { name, inject, apply }
