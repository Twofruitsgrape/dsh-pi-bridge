/**
 * Load a DSH plugin bundle at runtime, from inside a DSH process.
 *
 * Verified against a real host: a bundle installed by the plugin manager is a
 * symlink under the profile's node_modules, so a bare specifier such as
 * '@deepseek-ai/dsh-tools' cannot resolve from it (MODULE_NOT_FOUND), while the
 * build's own node_modules are reachable by absolute path from
 * process.execPath through the Electron-patched fs. So bare host specifiers are
 * rewritten to file URLs of the host's genuine modules - not stubs - and the
 * result is imported and applied against the live ctx. Relative and node:
 * specifiers are untouched, so a bundle still reads its own files normally.
 *
 * @module src/dsh-loader.js
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

/** Specifier families the running build supplies. */
const HOST_PREFIXES = ['@deepseek-ai/', '@deepseek-harness/', 'cordis', 'schemastery', '@cordiverse/']

export function isHostSpecifier (s) {
  return HOST_PREFIXES.some((p) => s === p || s.startsWith(p.endsWith('/') ? p : p + '/'))
}

/** The installed build's own node_modules roots, reachable only under Electron. */
export function hostModulesRoots (execPath = process.execPath) {
  const root = path.dirname(String(execPath || ''))
  return [
    path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules'),
    path.join(root, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'),
  ].filter((r) => r !== path.join('', 'resources'))
}

/** Resolve one host specifier to a real module file inside the running build. */
export function hostEntry (specifier, roots = hostModulesRoots()) {
  for (const r of roots) {
    try { return createRequire(path.join(r, 'noop.js')).resolve(specifier) } catch { /* next root */ }
  }
  return null
}

function toUrl (file) {
  const s = String(file).replace(/\\/g, '/')
  return (/^[A-Za-z]:\//.test(s) ? 'file:///' + s : 'file://' + s)
}

/**
 * Rewrite bare host specifiers in a source text to file URLs of the host's own
 * modules. Returns the rewritten code and what it mapped, so a caller can
 * report exactly which host packages the bundle ended up using.
 * @param {string} source
 * @param {(spec:string)=>string|null} resolveSpec
 */
export function rewriteHostSpecifiers (source, resolveSpec = hostEntry) {
  const mapped = []
  const code = source.replace(/(\bfrom\s+|\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g, (whole, head, quote, spec) => {
    if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('file:') || !isHostSpecifier(spec)) return whole
    const file = resolveSpec(spec)
    if (!file) return whole
    mapped.push({ specifier: spec, target: file })
    return head + '"' + toUrl(file) + '"'
  })
  return { code, mapped }
}

/**
 * Load one bundle directory against a live DSH scope.
 * @param {string} dir bundle root
 * @param {any} ctx the scope this plugin was applied with
 * @param {{genDir:string, log?:(m:string)=>void, entry?:(dir:string,pkg:any)=>Promise<string|null>}} opts
 * @returns {Promise<{name:string, tools:any[], commands:any[], mapped:any[], error?:string}>}
 */
export async function loadDshBundle (dir, ctx, opts) {
  const log = (opts && opts.log) || (() => {})
  const { classify, dshEntry } = await import('./manifest.js')
  const info = await classify(dir)
  const entryFile = (opts && opts.entry) ? await opts.entry(dir, info.pkg) : await dshEntry(dir, info.pkg)
  if (!entryFile) return { name: info.name, tools: [], commands: [], mapped: [], error: 'no DSH entry module found' }

  const tools = []
  const commands = []
  /** Callable tool definitions this load registered, keyed by name. */
  const callable = new Map()
  // Recording wrappers so the caller learns what the bundle registered, while
  // the registrations themselves go to the real host.
  const scope = observeScope(ctx, tools, commands)
  let target = entryFile
  try {
    const source = readFileSync(entryFile, 'utf8')
    const { code, mapped } = rewriteHostSpecifiers(source)
    if (mapped.length) {
      const genDir = opts.genDir
      mkdirSync(genDir, { recursive: true })
      target = path.join(genDir, slug(info.name) + '-' + Date.now().toString(36) + '.mjs')
      writeFileSync(target, code, 'utf8')
      log('rewrote ' + mapped.map((m) => m.specifier).join(', '))
    }
    const mod = await import(pathToFileURL(target).href)
    const apply = (mod && mod.apply) || (mod.default && mod.default.apply)
    if (typeof apply !== 'function') {
      return { name: info.name, tools: [], commands: [], mapped: [], error: 'bundle exports no apply()' }
    }
    await apply(scope, (mod.default && mod.default.config) || {})
    for (const t of tools) callable.set(t.name, t.def)
    return {
      name: info.name,
      // Strip the definition before returning it across a boundary.
      tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      commands,
      mapped: [],
      callable,
    }
  } catch (e) {
    return { name: info.name, tools: [], commands: [], mapped: [], error: String((e && e.message) || e).slice(0, 300) }
  }
}

/**
 * A scope view that records registrations without touching the real scope.
 *
 * The host scope forbids property assignment ("cannot set property "tools" in
 * multiple fibers", measured on a live DSH boot), so this cannot copy or
 * subclass it. A get-only Proxy intercepts the two services we want to observe
 * and forwards everything else, including the underlying register calls, so the
 * bundle registers for real and the host accepts it exactly as it accepts a
 * boot-time plugin.
 */
function observeScope (ctx, tools, commands) {
  const recording = (kind, sink) => {
    const real = ctx[kind]
    return new Proxy(real, {
      get (target, prop) {
        if (prop === 'register') {
          return (def) => {
            const name = String((def && def.name) || 'unnamed')
            if (kind === 'tools') sink.push({ name, description: String((def && def.description) || ''), parameters: (def && def.parameters) || null, def })
            else sink.push({ name, description: String((def && def.description) || '') })
            return target.register(def)
          }
        }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return new Proxy(ctx, {
    get (target, prop) {
      if (prop === 'tools' && target.tools) return recording('tools', tools)
      if (prop === 'commands' && target.commands) return recording('commands', commands)
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
    // Never write through to the host scope.
    set () { return false },
  })
}

function slug (s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'bundle'
}

/** Kept for tests: read a file if it exists, else null. */
export async function readIfExists (p) {
  try { return await readFile(p, 'utf8') } catch { return null }
}
