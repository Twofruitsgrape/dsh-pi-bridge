/**
 * dsh-pi-bridge bootstrap: runs INSIDE the real pi process.
 *
 * This is the core of the proxy design: a bridged pi package is never
 * translated into DSH. It loads into pi, where modelRegistry, credentials,
 * ctx.ui and its own published dependencies are the genuine article. This file
 * loads the materialized package roots, forwards their registrations to the
 * real pi API so the tools are live in pi itself, records their definitions for
 * direct calls, and opens a loopback endpoint a DSH session can invoke.
 *
 * TypeScript is handled by the same jiti pi uses, resolved from pi's own install
 * (PI_MODULE_DIR), and pi's host-provided packages are aliased to pi's real
 * modules so a package imports the genuine ExtensionAPI types and registries
 * rather than a stub.
 *
 * Environment:
 *   DSH_PI_BRIDGE_PACKAGES   JSON array of materialized package roots
 *   DSH_PI_BRIDGE_PORT       loopback port for the in-process endpoint
 *   PI_MODULE_DIR            pi package directory (for jiti + host aliases)
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.DSH_PI_BRIDGE_PORT || 0)
const PI_MODULE_DIR = process.env.PI_MODULE_DIR || ''
const PACKAGES = (() => {
  try { return JSON.parse(process.env.DSH_PI_BRIDGE_PACKAGES || '[]') } catch { return [] }
})()

/** pi supplies these to extensions; they must resolve to pi's real modules. */
const HOST_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
  '@earendil-works/pi-mcp',
  'typebox',
]

/** Follow a package's own export map to a file path. */
function pickEntry (exp) {
  if (!exp) return null
  if (typeof exp === 'string') return exp
  for (const key of ['import', 'default', 'require', 'node']) {
    const v = exp[key]
    if (v) { const r = pickEntry(v); if (r) return r }
  }
  const first = Object.values(exp).find(v => typeof v === 'string')
  return first || null
}

/**
 * Resolve one host package to a loadable file. req.resolve fails for a package
 * whose export map has no '.'-string form, so fall back to its package.json,
 * with the special case that pi-coding-agent IS the module directory.
 */
function resolveHost (req, name, selfName) {
  try { return req.resolve(name) } catch { /* fall through */ }
  const dirs = [path.join(PI_MODULE_DIR, 'node_modules', name)]
  if (selfName && name === selfName) dirs.unshift(PI_MODULE_DIR)
  for (const dir of dirs) {
    let pkg = null
    try { pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { continue }
    const rel = pickEntry(pkg.exports && pkg.exports['.']) || pkg.main
    if (!rel) continue
    const full = path.resolve(dir, rel)
    if (existsSync(full)) return full
  }
  return null
}

const recorded = new Map()
/** Commands the loaded packages registered; reported so a host can say what exists in pi. */
const recordedCommands = new Map()
const loadErrors = []
/** Normal events kept apart from failures, so a report cannot look broken when it is not. */
const notes = []
let liveCtx = null
let server = null
let jiti = null

/**
 * Build a loader that behaves like pi's own extension loading: jiti for TS, with
 * pi's host-provided packages mapped to the real modules pi supplies.
 */
function makeLoader () {
  if (!PI_MODULE_DIR) { loadErrors.push('PI_MODULE_DIR unset: cannot load TypeScript extensions'); return null }
  try {
    const req = createRequire(path.join(PI_MODULE_DIR, 'package.json'))
    const jitiFactory = req('jiti')
    // pi loads extensions with createJiti(...).import(file, { default: true }).
    // The synchronous callable instead runs the CJS pipeline, so an ESM-only
    // dependency (p-limit, undici) loses its default interop and a package that
    // works in pi fails here for a reason that has nothing to do with the package.
    const createJiti = typeof jitiFactory.createJiti === 'function' ? jitiFactory.createJiti : null
    // jiti takes resolved file paths. Aliasing pi's host-provided packages to
    // pi's own modules is what makes the proxy honest: a bridged package gets the
    // genuine ExtensionAPI, typebox and model registry, never a stub.
    let selfName = ''
    try { selfName = JSON.parse(readFileSync(path.join(PI_MODULE_DIR, 'package.json'), 'utf8')).name || '' } catch { /* unknown */ }
    const alias = {}
    for (const name of HOST_PACKAGES) {
      const target = resolveHost(req, name, selfName)
      if (target) alias[name] = target
      else loadErrors.push('no host module for ' + name)
    }
    return createJiti ? createJiti(path.join(HERE, 'noop.js'), { moduleCache: false, interop: 'auto', alias })
      : jitiFactory(HERE, { interop: 'auto', tryNative: true, moduleCache: false, alias })
  } catch (e) {
    loadErrors.push('jiti unavailable: ' + String(e && e.message).slice(0, 160))
    return null
  }
}

/**
 * Load one extension file. Returns the module namespace (or the default export
 * where pi's { default: true } form applies), asynchronously so jiti takes the
 * ESM path exactly as the pi runtime does.
 */
async function resolveFile (file) {
  if (!jiti) return import(pathToFileURL(file).href)
  if (typeof jiti.import === 'function') return jiti.import(file, { default: false })
  return jiti(file)
}

function describe (name, entry) {
  const def = entry.def
  return {
    name,
    origin: entry.origin,
    label: def.label || name,
    description: def.description || '',
    parameters: def.parameters || null,
  }
}

function json (res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function loadPackage (root, pi) {
  let manifest = null
  try { manifest = await import(pathToFileURL(path.resolve(HERE, '..', 'src', 'manifest.js')).href) }
  catch (e) { loadErrors.push('manifest.js: ' + String(e && e.message).slice(0, 140)) }
  let files = []
  if (manifest && manifest.piEntries && manifest.readJson) {
    try {
      const pkg = await manifest.readJson(path.join(root, 'package.json'))
      files = (await manifest.piEntries(root, pkg)).extensions
    } catch (e) { loadErrors.push(root + ': manifest parse ' + String(e && e.message).slice(0, 140)) }
  }
  if (!files.length) {
    for (const cand of ['extensions/index.ts', 'extensions/index.js', 'index.ts', 'index.js']) {
      const p = path.join(root, cand)
      try { await (await import('node:fs/promises')).stat(p); files.push(p); break } catch { /* next */ }
    }
  }
  const seen = new Set()
  for (const file of files) {
    if (seen.has(file)) continue
    seen.add(file)
    try {
      const mod = await resolveFile(file)
      const factory = mod && (mod.default || mod.activate || (typeof mod === 'function' ? mod : null))
      if (typeof factory !== 'function') { loadErrors.push(path.basename(file) + ': no default extension factory'); continue }
      await factory(apiFor(pi, path.basename(root)))
      notes.push('loaded ' + path.basename(file))
    } catch (e) {
      loadErrors.push(file + ': ' + String(e && e.message).slice(0, 220))
    }
  }
}

/** Proxy that records registerTool while forwarding every call to real pi. */
function apiFor (pi, origin) {
  return new Proxy(pi, {
    get (target, prop) {
      const value = target[prop]
      if (typeof value !== 'function') return value
      if (prop === 'registerTool') {
        return (...args) => {
          const def = args[0] || {}
          if (def && def.name) recorded.set(String(def.name), { def, origin })
          return value.apply(target, args)
        }
      }
      if (prop === 'registerCommand') {
        return (...args) => {
          const [name, opts] = args
          if (name) recordedCommands.set(String(name), { origin, description: (opts && opts.description) || '' })
          return value.apply(target, args)
        }
      }
      return value.bind(target)
    },
  })
}

function startServer (pi) {
  if (server || !PORT) return
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const url = (req.url || '/').split('?')[0]
      try {
        if (url === '/health') return json(res, 200, { ok: true, pid: process.pid, tools: recorded.size, ctx: !!liveCtx, notes: notes.slice(-4), log: loadErrors.slice(-6) })
        if (url === '/tools') {
          return json(res, 200, {
            tools: (pi.getAllTools ? pi.getAllTools() : []).map((t) => ({
              name: t.name,
              origin: recorded.has(t.name) ? 'bridge' : 'pi-unreachable',
              label: t.label || t.name,
              description: String(t.description || ''),
              parameters: t.parameters || null,
            })),
            errors: loadErrors,
            notes,
            liveCtx: !!liveCtx,
            commands: [...recordedCommands.entries()].map(([n, c]) => ({ name: n, origin: c.origin, description: c.description })),
            activeInPi: pi.getActiveTools ? pi.getActiveTools() : undefined,
          })
        }
        if (url === '/alltools') {
          const list = pi.getAllTools ? pi.getAllTools() : []
          return json(res, 200, {
            count: list.length,
            sample: list.slice(0, 4).map((t) => ({ name: t.name, keys: Object.keys(t).sort().join(','), hasExecute: typeof t.execute === 'function' })),
          })
        }
        if (url === '/load') {
          const { root } = JSON.parse(raw || '{}')
          if (!root) return json(res, 200, { ok: false, error: 'no package root given' })
          const before = new Set(recorded.keys())
          await loadPackage(root, pi)
          const added = [...recorded.keys()].filter(n => !before.has(n))
          return json(res, 200, {
            ok: true,
            added: added.map(n => describe(n, recorded.get(n))),
            commands: [...recordedCommands.entries()].filter(([n]) => n).map(([n, c]) => ({ name: n, origin: c.origin, description: c.description })),
            errors: loadErrors.slice(-4),
            notes: notes.slice(-4),
          })
        }
        if (url === '/call') {
          const { name, args } = JSON.parse(raw || '{}')
          // Only tools the bridge loaded are callable. ExtensionAPI exposes no
          // getToolDefinition (verified against the installed pi's own types), so
          // a tool pi loaded by itself has no reachable execute() from here; the
          // daemon therefore loads packages through --packages or /load, and
          // pi's own discovery is turned off with --no-extensions to keep exactly
          // one copy of each registration.
          const entry = recorded.get(name)
          const def = entry && entry.def
          if (!def) return json(res, 200, { ok: false, error: 'unknown tool: ' + name })
          if (typeof def.execute !== 'function') return json(res, 200, { ok: false, error: 'tool has no execute' })
          if (!liveCtx) return json(res, 200, { ok: false, error: 'no extension context captured yet' })
          const t0 = Date.now()
          try {
            const out = await def.execute('dsh-pi-bridge', args || {}, undefined, undefined, liveCtx)
            return json(res, 200, { ok: true, ms: Date.now() - t0, result: out })
          } catch (e) {
            return json(res, 200, { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 400) })
          }
        }
        json(res, 404, { ok: false, error: 'not found' })
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e).slice(0, 400) })
      }
    })
  })
  server.on('error', (e) => loadErrors.push('http: ' + e.message))
  server.listen(PORT, '127.0.0.1', () => notes.push('listening 127.0.0.1:' + PORT))
}

export default async function (pi) {
  // pi's contract: no sockets in the factory. The listener opens with the session.
  pi.on('session_start', async (_event, ctx) => {
    liveCtx = liveCtx || ctx
    startServer(pi)
  })
  for (const ev of ['before_agent_start', 'agent_start', 'turn_start']) {
    pi.on(ev, async (_e, ctx) => { liveCtx = liveCtx || ctx })
  }
  jiti = makeLoader()
  for (const root of PACKAGES) await loadPackage(root, pi)
}