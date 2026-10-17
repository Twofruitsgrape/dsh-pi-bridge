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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

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
 * Rewrite every JavaScript file in a bundle directory, in place.
 *
 * Rewriting only the entry and importing it from another directory broke two real
 * bundles, in both directions: their relative imports ('./compositions.js') then
 * resolved next to the rewritten copy instead of inside the package, and host
 * specifiers imported by a *deeper* file ('lib/dsh/preset-installation.js' pulling
 * in '@deepseek-ai/schemastery') were never rewritten at all. So the whole tree
 * gets transformed and stays where it is: relative imports keep working because
 * the files never moved, and no specifier is missed because nothing is special
 * about the entry.
 *
 * The directory is the bridge's own cache copy, never the user's installed
 * bundle. Re-running is harmless: a rewritten specifier is a file: URL, which the
 * rewriter leaves alone.
 *
 * @param {string} dir bundle root inside the cache
 * @param {(spec:string)=>string|null} resolveSpec
 * @param {{log?:(m:string)=>void, limit?:number, cacheRoot?:string}} [opts]
 * @returns {{files:number, mapped:string[], refused?:boolean}}
 */
export function rewriteBundleTree (dir, resolveSpec = hostEntry, opts) {
  const log = (opts && opts.log) || (() => {})
  const limit = (opts && opts.limit) || 4000
  // Refuse to touch anything outside the bridge's own cache. Rewriting in place is
  // what keeps a bundle's relative imports working, so the directory handed here
  // must be the copy the bridge made, never a directory someone owns: a plugin
  // author pointing dsh_install at their own working tree would otherwise have
  // their source files replaced with host-module URLs. Measured the hard way - an
  // offline test that passed a repository path rewrote the committed fixture.
  // The cache root is recomputed here rather than imported from resolve.js: that
  // module reaches this one through the entry points, and a cycle would make both
  // unreadable. The same expression, and callers may pass their own.
  const cacheRoot = (opts && opts.cacheRoot) || process.env.DSH_PI_BRIDGE_HOME || path.join(os.homedir(), ".dsh-pi-bridge")
  const inside = cacheRoot && path.resolve(dir).startsWith(path.resolve(cacheRoot) + path.sep)
  if (!inside) {
    log('refusing to rewrite outside the bridge cache: ' + dir)
    return { files: 0, mapped: [], refused: true }
  }
  const mapped = new Set()
  let files = 0
  const walk = (current, depth) => {
    if (depth > 12 || files >= limit) return
    let entries = []
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!/\.(m?js|cjs)$/.test(e.name) || e.name.endsWith('.map')) continue
      let source = ''
      try { source = readFileSync(full, 'utf8') } catch { continue }
      files++
      if (!/from\s+['"]|import\s*\(/.test(source)) continue
      const { code, mapped: hits } = rewriteHostSpecifiers(source, resolveSpec)
      if (!hits.length) continue
      for (const h of hits) mapped.add(h.specifier)
      try { writeFileSync(full, code, 'utf8') } catch (err) { log('could not rewrite ' + e.name + ': ' + String(err && err.code)) }
    }
  }
  walk(dir, 0)
  return { files, mapped: [...mapped] }
}

/**
 * Load one bundle directory against a live DSH scope.
 * @param {string} dir bundle root
 * @param {any} ctx the scope this plugin was applied with
 * @param {{log?:(m:string)=>void, entry?:(dir:string,pkg:any)=>Promise<string|null>, registered?:Set<string>, resolveSpec?:(s:string)=>string|null}} opts
 *        registered: tool names this session already has. The host rejects a
 *        duplicate ("tool X is already registered", measured on a live boot), and
 *        a second request for a bundle the user already installed is the normal
 *        case, not an error: pi asking to use what DSH already loaded.
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
  /** Skill providers the bundle registers: real capability, just not callable. */
  const skillCount = { count: 0 }
  /** Names the host refused because they already exist; reported, not fatal. */
  const alreadyPresent = []
  /** Registrations the host refused because the name was taken. */
  const conflicts = []
  /** Callable tool definitions this load registered, keyed by name. */
  const callable = new Map()
  const registered = (opts && opts.registered) || new Set()
  // Recording wrappers so the caller learns what the bundle registered, while
  // the registrations themselves go to the real host.
  const scope = observeScope(ctx, tools, commands, skillCount, registered, alreadyPresent, conflicts)
  try {
    const tree = rewriteBundleTree(dir, opts.resolveSpec || hostEntry, { log })
    if (tree.mapped.length) log('rewrote ' + tree.files + ' file(s), host specifiers: ' + tree.mapped.join(', '))
    const mod = await import(pathToFileURL(entryFile).href)
    const apply = (mod && mod.apply) || (mod.default && mod.default.apply)
    if (typeof apply !== 'function') {
      return { name: info.name, tools: [], commands: [], skills: 0, mapped: [], error: 'no DSH apply() exported from ' + path.basename(entryFile) + ': this bundle contributes configuration or a host bridge rather than a plugin module, so there is nothing to load at runtime' }
    }
    /**
     * A bundle is applied in a scope built for IT, not for the bridge.
     *
     * Cordis resolves a service out of the fiber that declared it, so reading
     * ctx.llm from a fiber that only injected 'tools' throws 'cannot get property
     * "llm" without inject' - measured on a live session against four real
     * bundles. The host's own mechanism for reaching services on demand is
     * ctx.inject(names, fn), which opens a child scope carrying exactly those
     * names; the bundle's declared inject list is what it needs, plus the ones it
     * registers into. This is also how the bridge mounts skills for itself.
     */
    const wants = Array.isArray(mod.inject) ? mod.inject.slice() : []
    for (const need of ['tools', 'commands']) if (!wants.includes(need)) wants.push(need)
    let injected = true
    if (typeof ctx.inject === 'function') {
      try {
        await ctx.inject(wants, (inner) => apply(observeScope(inner, tools, commands, skillCount, registered, alreadyPresent, conflicts), (mod.default && mod.default.config) || {}))
      } catch (e) {
        injected = false
        // Two different causes read the same way if blamed on the profile, so
        // tell them apart. A bundle whose apply() reads config.<field>.get() is
        // asking for values the host binds from the plugin's Config schema and
        // its patch row - the bridge cannot fabricate those, and calling that a
        // missing service would send the user to mount something that already
        // exists. dsh-plugin-model-proxy failed this way and my first report
        // named the wrong cause.
        const msg = String((e && e.message) || e)
        const configBound = /Cannot read properties of undefined \(reading 'get'\)|is not a function|reading 'set'/.test(msg)
        return {
          name: info.name, tools: [], commands: [], skills: 0, mapped: [],
          error: configBound
            ? 'needs configuration the host binds from its Config schema and patch row (apply() reads config.<field>.get()), which a runtime load cannot fabricate - mount it as a profile bundle instead (dsh plugin --profile <name> install <source>): ' + msg.slice(0, 120)
            : 'needs the "' + (wants.join('", "') || 'service') + '" service, which this profile does not compose: ' + msg.slice(0, 140),
        }
      }
    } else {
      await apply(scope, (mod.default && mod.default.config) || {})
    }
    void injected
    for (const t of tools) callable.set(t.name, t.def)
    // A reused tool is still callable: its definition came from the first load,
    // which is why the caller keeps one shared registry rather than this map.
    return {
      name: info.name,
      skills: skillCount.count,
      // Strip the definition before returning it across a boundary.
      tools: tools
        .filter((t) => !alreadyPresent.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      reused: [...alreadyPresent],
      conflicts,
      commands,
      mapped: tree.mapped,
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
function observeScope (ctx, tools, commands, skillCounter, registered, alreadyPresent, conflicts) {
  const recording = (kind, sink) => {
    const real = ctx[kind]
    return new Proxy(real, {
      get (target, prop) {
        if (prop === 'register') {
          return (def) => {
            const name = String((def && def.name) || 'unnamed')
            if (kind === 'tools') {
              if (registered.has(name)) { alreadyPresent.push(name); return { dispose () {} } }
              sink.push({ name, description: String((def && def.description) || ''), parameters: (def && def.parameters) || null, def })
            }
            else sink.push({ name, description: String((def && def.description) || '') })
            try {
              return target.register(def)
            } catch (e) {
              // The host throws on a name it already has, and a bundle that
              // collides with a mounted plugin is the normal case, not a broken
              // one. Losing that one tool must not abort the whole bundle, so the
              // conflict is reported and registration of the rest continues.
              conflicts.push({ name, reason: String((e && e.message) || e).slice(0, 140) })
              return { dispose () {} }
            }
          }
        }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return new Proxy(ctx, {
    get (target, prop) {
      // A bundle registers from inside its own ctx.inject callback all the
      // time - dsh-super-code and dsh-thinking-levels both do - and the host hands
      // that callback a scope of its own, not the one this loader handed to apply().
      // Wrapping only the apply() scope therefore misses every deferred tool: the
      // host has it, the bridge reports none, and the other host is told the bundle
      // contributed nothing. So the callback's argument gets wrapped too.
      if (prop === 'inject') {
        const inject = target.inject
        if (typeof inject !== 'function') return inject
        return (names, fn) => inject.call(target, names, (inner) => fn(observeScope(inner, tools, commands, skillCounter, registered, alreadyPresent, conflicts)))
      }
      if (prop === 'tools' && target.tools) return recording('tools', tools)
      if (prop === 'commands' && target.commands) return recording('commands', commands)
      if (prop === 'skills' && target.skills) {
        return new Proxy(target.skills, {
          get (st, sp) {
            if (sp === 'registerProvider') {
              return (fn) => { skillCounter.count++; return st.registerProvider(fn) }
            }
            const v = st[sp]
            return typeof v === 'function' ? v.bind(st) : v
          },
        })
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
    // Never write through to the host scope.
    set () { return false },
  })
}

/** Kept for tests: read a file if it exists, else null. */
export async function readIfExists (p) {
  try { return await readFile(p, 'utf8') } catch { return null }
}
