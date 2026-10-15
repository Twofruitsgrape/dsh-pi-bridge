/**
 * Import surface scanning and inert stub generation.
 *
 * A foreign plugin statically imports host packages that do not exist on the
 * other side: a pi extension imports @earendil-works/pi-coding-agent and
 * typebox; a DSH bundle imports @deepseek-ai/dsh-tools and
 * @deepseek-ai/schemastery. Under ESM a missing named export is a link-time
 * SyntaxError, so an empty module is not enough - the stub has to export the
 * exact names the foreign code asks for. The sources are on disk, so we read
 * them and collect the names.
 *
 * Each collected name becomes either a real implementation the caller supplies
 * (defineTool, Type, z) or an inert value: callable, chainable, awaitable, and
 * naming itself when coerced to a string. A plugin that only reads its config
 * through such a binding keeps working; one that genuinely needs it gets an
 * error text that says which binding was missing.
 *
 * @module src/stubs.js
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const IMPORT_RE = /(?:^|[\s;{}()])(?:import|export)\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g
const BARE_RE = /(?:^|[\s;{}()])import\s*['"]([^'"]+)['"]/g
const DYN_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * A real bare specifier can only use the characters npm allows. The import
 * regex reads raw source text, so fragments of string literals ("... from ' + x")
 * get captured as well; those never look like this and must not become stubs.
 */
const PACKAGE_NAME = /^(?:@[\w][\w.~-]*\/)?[\w][\w.~-]*(?:\/[\w@.%+~-]+)*$/

export function isPlausibleSpecifier (spec) {
  if (typeof spec !== 'string' || !spec || spec.length > 120) return false
  if (spec.includes('://') || spec.includes('\\') || /\s/.test(spec)) return false
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return false
  return PACKAGE_NAME.test(spec)
}

const BUILTIN = new Set(['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'test', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'])

/** Node builtins and core packages must never be stubbed. */
export function isBuiltinSpecifier (spec) {
  if (spec.startsWith('node:')) return true
  const [pkg] = splitSpecifier(spec)
  return BUILTIN.has(pkg)
}

function readClause (clause, entry) {
  if (!clause) return
  const braces = clause.match(/\{([\s\S]*?)\}/)
  if (braces) {
    for (const piece of braces[1].split(',')) {
      const t = piece.trim()
      if (!t) continue
      // "parse as parseYaml": ESM links against the ORIGINAL name, not the alias.
      const parts = t.split(/\s+as\s+/)
      entry.named.add(parts[0].trim())
    }
    const head = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, ' ').trim()
    if (head && !head.startsWith('*')) entry.default = true
  }
  if (/\*\s+as\s+\S+/.test(clause)) entry.namespace = true
  if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(clause)) entry.default = true
}

/** Per-specifier binding demands found in one source text. */
export function specifiersOf (source) {
  const map = new Map()
  const add = (spec, clause) => {
    if (!isPlausibleSpecifier(spec) || isBuiltinSpecifier(spec)) return
    if (!map.has(spec)) map.set(spec, { named: new Set(), default: false, namespace: false })
    readClause(clause, map.get(spec))
  }
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(source))) add(m[2], m[1])
  BARE_RE.lastIndex = 0
  while ((m = BARE_RE.exec(source))) add(m[1], null)
  DYN_RE.lastIndex = 0
  while ((m = DYN_RE.exec(source))) add(m[1], null)
  return map
}

/**
 * Every non-relative import the given files ask for, by specifier.
 * @param {string[]} files absolute source paths
 */
export async function scanImports (files) {
  const all = new Map()
  for (const file of files) {
    let source = ''
    try { source = await readFile(file, 'utf8') } catch { continue }
    for (const [spec, entry] of specifiersOf(source)) {
      if (!all.has(spec)) all.set(spec, { named: new Set(), default: false, namespace: false })
      const target = all.get(spec)
      for (const n of entry.named) target.named.add(n)
      if (entry.default) target.default = true
      if (entry.namespace) target.namespace = true
    }
  }
  return all
}

/** '@scope/pkg/sub' -> ['@scope/pkg','sub']; 'pkg' -> ['pkg',null] */
export function splitSpecifier (spec) {
  const parts = spec.split('/')
  if (spec.startsWith('@') && parts.length >= 2) {
    const pkg = parts.slice(0, 2).join('/')
    return [pkg, parts.length > 2 ? parts.slice(2).join('/') : null]
  }
  return [parts[0], parts.length > 1 ? parts.slice(1).join('/') : null]
}

/** Bridge-owned directory inside a mirror; never the package's own src/. */
const BRIDGE_DIR = '_dsh_pi_bridge'

const SAFE = /^[_$A-Za-z][_$A-Za-z0-9]*$/
function safeName (n) { return SAFE.test(n) ? n : 'X_' + n.replace(/[^A-Za-z0-9]/g, '_') }

/** POSIX file URL from a Windows or POSIX absolute path. */
export function toFileUrl (p) {
  const s = path.resolve(p).replace(/\\/g, '/')
  return (/^[A-Za-z]:\//.test(s) ? 'file:///' + s : 'file://' + s)
}

/**
 * Write stub packages under root/node_modules for what the foreign code imports.
 * @param {string} root mirror root that gets the node_modules
 * @param {Map<string, any>} specs result of scanImports
 * @param {{provide?: Record<string, Record<string, string>>}} options
 *        provide: specifier -> binding -> source expression replacing the inert value
 * @returns {Promise<string[]>} package names written
 */
export async function makeStubs (root, specs, options) {
  const provide = (options && options.provide) || {}
  const inertUrl = toFileUrl(path.join(root, BRIDGE_DIR, 'inert.mjs'))
  const byPackage = new Map()
  const record = (bucket, entry, given) => {
    for (const n of entry.named) bucket.named.add(n)
    if (entry.default) bucket.default = true
    for (const k of Object.keys(given || {})) bucket.named.add(k)
  }
  for (const [spec, entry] of specs) {
    if (isBuiltinSpecifier(spec) || !isPlausibleSpecifier(spec)) continue
    const [pkg, sub] = splitSpecifier(spec)
    if (!byPackage.has(pkg)) byPackage.set(pkg, { named: new Set(), default: false, subs: new Map() })
    const bucket = byPackage.get(pkg)
    const given = provide[spec] || {}
    if (sub) {
      if (!bucket.subs.has(sub)) bucket.subs.set(sub, { named: new Set(), default: false })
      record(bucket.subs.get(sub), entry, given)
    } else {
      record(bucket, entry, given)
    }
  }

  const written = []
  for (const [pkg, bucket] of byPackage) {
    const dir = path.join(root, 'node_modules', ...pkg.split('/'))
    // A real dependency that was installed into the mirror outranks a stub:
    // overwriting it would break the package we are trying to bridge.
    if (await hasRealPackage(dir)) continue
    await mkdir(dir, { recursive: true })
    const exportsMap = { '.': './index.mjs' }
    for (const sub of bucket.subs.keys()) exportsMap['./' + sub] = './' + sub + '.mjs'
    exportsMap['./*'] = './*.mjs'
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: pkg,
      version: '0.0.0-dsh-pi-bridge',
      type: 'module',
      main: './index.mjs',
      exports: exportsMap,
    }, null, 2) + '\n', 'utf8')
    await writeFile(path.join(dir, 'index.mjs'), moduleBody(bucket, provide[pkg] || {}, pkg, inertUrl, options.prelude), 'utf8')
    for (const [sub, s] of bucket.subs) {
      const target = path.join(dir, ...sub.split('/')) + '.mjs'
      await mkdir(path.dirname(target), { recursive: true })
      const given = provide[pkg + '/' + sub] || {}
      await writeFile(target, moduleBody(s, given, pkg + '/' + sub, inertUrl, options.prelude), 'utf8')
    }
    written.push(pkg)
  }

  await mkdir(path.join(root, BRIDGE_DIR), { recursive: true })
  await writeFile(path.join(root, BRIDGE_DIR, 'inert.mjs'), INERT_MODULE, 'utf8')
  return written
}

/** True when a genuine package.json (not one we generated) is already there. */
async function hasRealPackage (dir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
    return !(String(pkg.version || '').includes('dsh-pi-bridge') || !pkg.main && !pkg.exports)
  } catch { return false }
}

function moduleBody (entry, given, label, inertUrl, prelude) {
  const lines = ['import { inert } from ' + JSON.stringify(inertUrl)]
  if (prelude) lines.push(prelude)
  const names = new Set(entry.named)
  for (const name of names) {
    if (name === 'default') continue
    const impl = given[name]
    lines.push('export const ' + safeName(name) + ' = ' + (impl || 'inert(' + JSON.stringify(label + '#' + name) + ')'))
  }
  if (entry.default) {
    lines.push('export default ' + (given.default || 'inert(' + JSON.stringify(label + '#default') + ')'))
  }
  return lines.join('\n') + '\n'
}

/** One line that re-exports the bridge's own inert implementation by URL. */
const INERT_MODULE = 'export { inert, default } from ' + JSON.stringify(toFileUrl(path.join(HERE, 'inert.js'))) + '\n'
