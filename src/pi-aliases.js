/**
 * The alias table a bridged package needs to import pi's own modules.
 *
 * jiti's alias is a literal prefix substitution, measured on pi's own jiti: with
 * only the package name aliased to a file, an import of
 * '@earendil-works/pi-ai/compat' becomes '<...>/dist/index.js/compat' and fails.
 * When the longer subpath key is present it wins, in either key order. So the
 * table has to name every subpath a package may ask for - which is exactly what
 * pi's own extension loader does, and this mirrors that table instead of
 * inventing a smaller one. A real package (pi-web-search) loaded with no tools at
 * all purely because an earlier version listed only package names.
 *
 * Specifiers are resolved through pi's own require, so the installed packages'
 * export maps decide where each entry points.
 *
 * @module src/pi-aliases.js
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** pi supplies these to extensions; both scopes it accepts. */
const SCOPES = ['@earendil-works', '@mariozechner']
/** [package, subpath|null] pairs pi itself lists. */
const ENTRIES = [
  ['pi-coding-agent', null],
  ['pi-agent-core', null],
  ['pi-tui', null],
  ['pi-ai', 'compat'],
  ['pi-ai', 'oauth'],
  ['pi-ai', 'providers/all'],
  ['pi-ai', null],
]
/** TypeBox under both names packages use. */
const TYPEBOX = [
  'typebox', 'typebox/compile', 'typebox/value',
  '@sinclair/typebox', '@sinclair/typebox/compile', '@sinclair/typebox/value',
]

/** Every specifier a bridged package may legitimately ask pi for. */
export function hostSpecifiers () {
  const specs = []
  for (const scope of SCOPES) {
    for (const [pkg, sub] of ENTRIES) {
      const base = scope + '/' + pkg
      specs.push(sub ? base + '/' + sub : base)
    }
  }
  for (const t of TYPEBOX) specs.push(t)
  return [...new Set(specs)]
}

function readPkg (dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { return null }
}

/** Follow one export value to a concrete file, preferring ESM entry points. */
function pickEntry (exp) {
  if (!exp) return null
  if (typeof exp === 'string') return exp
  if (Array.isArray(exp)) return exp.find((v) => typeof v === 'string') || null
  for (const key of ['import', 'default', 'require', 'node']) {
    const v = exp[key]
    if (v) { const r = pickEntry(v); if (r) return r }
  }
  const first = Object.values(exp).find((v) => typeof v === 'string')
  return typeof first === 'string' ? first : null
}

/** The directory holding a package, wherever pi installed it. */
export function packageDirectory (req, piDir, name) {
  // The host package itself is not inside its own node_modules.
  const self = readPkg(piDir)
  if (self && self.name === name) return piDir
  const candidates = [
    path.join(piDir, 'node_modules', name),
    path.join(path.dirname(piDir), name),
  ]
  for (const dir of candidates) {
    try { if (statSync(dir).isDirectory() && existsSync(path.join(dir, 'package.json'))) return dir } catch { /* next */ }
  }
  // Walk up from a resolved entry file to the nearest package.json.
  let file = null
  try { file = req.resolve(name) } catch { /* unknown */ }
  if (!file) return null
  let up = path.dirname(file)
  for (let i = 0; i < 8 && up !== path.dirname(up); i++) {
    if (existsSync(path.join(up, 'package.json'))) return up
    up = path.dirname(up)
  }
  return null
}

/** Resolve one host specifier to a file, via require or the package's export map. */
function resolveSpecifier (req, piDir, spec) {
  try { const f = req.resolve(spec); if (f && existsSync(f)) return f } catch { /* export map below */ }
  // '@scope/name/sub' -> package '@scope/name', subpath './sub'
  const parts = spec.split('/')
  const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const sub = parts.slice(name.split('/').length).join('/')
  const dir = packageDirectory(req, piDir, name)
  if (!dir) return null
  const pkg = readPkg(dir)
  if (!pkg) return null
  const exports = (pkg && pkg.exports) || {}
  let exp = exports[sub ? './' + sub : '.'] || null
  // A subpath may be covered only by a wildcard: pi-ai lists './providers/*' and
  // no './providers/all', while ESM resolution (what pi itself uses) matches the
  // wildcard. require() does not, so a lookup that misses the exact key has to
  // try the wildcard before giving up.
  if (!exp && sub) {
    for (const [key, value] of Object.entries(exports)) {
      if (!key.endsWith('/*')) continue
      const stem = key.slice(0, -1)
      if (('./' + sub).startsWith(stem)) { exp = value; break }
    }
  }
  const rel = sub ? pickEntry(exp) : (pickEntry(exp) || pkg.main)
  if (!rel) return null
  // A wildcard target keeps its '*' placeholder wherever it sits: pi-ai maps
  // './providers/*' to './dist/providers/*.js', so the star is not at the end and
  // slicing off the tail loses the extension. Substitute at the star itself.
  let out = rel
  if (sub && typeof rel === 'string' && rel.indexOf('*') >= 0) {
    const key = Object.keys(exports).find((k) => k.endsWith('/*') && ('./' + sub).startsWith(k.slice(0, -1)))
    if (key) {
      const rest = ('./' + sub).slice(key.indexOf('*'))
      out = rel.slice(0, rel.indexOf('*')) + rest + rel.slice(rel.indexOf('*') + 1)
    }
  }
  const full = path.resolve(dir, out)
  return existsSync(full) ? full : null
}

/**
 * Concrete aliases for a package's wildcard exports, e.g. pi-ai's
 * './providers/*'. A prefix table cannot express a wildcard, so each real file is
 * listed as its own key - the only way a package importing one of them resolves
 * without a runtime miss.
 */
export function expandWildcards (dir) {
  const out = {}
  const pkg = readPkg(dir)
  const exports = (pkg && pkg.exports) || {}
  for (const [key, value] of Object.entries(exports)) {
    if (!key.startsWith('./') || !key.endsWith('/*')) continue
    const target = pickEntry(value)
    // Extensions keep the star in the middle: './dist/providers/*.js'.
    if (!target || typeof target !== 'string' || target.indexOf('*') < 0) continue
    const specBase = key.slice(2, -2)
    const dirBase = target.slice(2, target.indexOf('*'))
    const suffix = target.slice(target.indexOf('*') + 1)
    const root = path.resolve(dir, dirBase)
    let names = []
    try { names = readdirSync(root) } catch { continue }
    for (const name of names) {
      if (suffix && !name.endsWith(suffix)) continue
      if (name.endsWith('.map')) continue
      const full = path.join(root, name)
      try { if (!statSync(full).isFile()) continue } catch { continue }
      const stem = name.slice(0, name.length - suffix.length)
      const spec = pkg.name + (specBase ? '/' + specBase + '/' + stem : '/' + stem)
      if (!out[spec]) out[spec] = full
    }
  }
  return out
}

/**
 * Build the alias table for a pi install.
 * @param {string} piDir directory of the installed pi package
 * @returns {{alias:Object<string,string>, missing:string[], skipped:string[]}}
 *          skipped names subpaths that exist only in the other scope.
 */
export function buildAliasTable (piDir) {
  const alias = {}
  const missing = []
  if (!piDir || !existsSync(path.join(piDir, 'package.json'))) {
    return { alias, missing: hostSpecifiers(), skipped: [] }
  }
  const req = createRequire(path.join(piDir, 'package.json'))
  for (const spec of hostSpecifiers()) {
    const file = resolveSpecifier(req, piDir, spec)
    if (file) alias[spec] = file
    else missing.push(spec)
  }
  // Wildcards from each package directory we actually found.
  const touched = new Set()
  for (const spec of Object.keys(alias)) {
    const parts = spec.split('/')
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (touched.has(name)) continue
    const dir = packageDirectory(req, piDir, name)
    if (!dir) continue
    touched.add(name)
    for (const [k, v] of Object.entries(expandWildcards(dir))) {
      if (!alias[k]) alias[k] = v
    }
  }
  // A renamed host module: pi publishes typebox, but packages still import the
  // old @sinclair/typebox name, and pi's own alias table maps both. Resolving
  // '@sinclair/typebox' by name finds nothing (there is no @sinclair directory),
  // so the alias has to be built by pointing the legacy name at the real
  // package's own resolved entry - the same subpath structure, different name.
  // Without it, a published package (@ff-labs/pi-fff) failed to load with
  // 'Cannot find module @sinclair/typebox' while typebox was sitting right there.
  const legacy = [
    ['@sinclair/typebox', 'typebox'],
    ['@sinclair/typebox/compile', 'typebox/compile'],
    ['@sinclair/typebox/value', 'typebox/value'],
  ]
  for (const [oldName, newName] of legacy) {
    if (alias[oldName]) continue
    const target = resolveSpecifier(req, piDir, newName)
    if (target) alias[oldName] = target
  }

  // '@mariozechner/*' is the legacy scope and '@sinclair/typebox' the old name:
  // absent in a modern install, which is not a failure - only a package that
  // actually imports them would need them, and pi lists both defensively.
  const optional = (s) => s.startsWith('@mariozechner/') || s.startsWith('@sinclair/')
  return { alias, missing: missing.filter((s) => !optional(s)), skipped: missing.filter(optional) }
}
