/**
 * Package manifest reading: which host is a directory a plugin for?
 *
 * Detection is structural (keywords + manifest keys + conventional
 * directories), because third-party packages often declare only part of the
 * manifest. One directory can be both hosts at once - this package is.
 *
 * @module src/manifest.js
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export async function readJson (file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function exists (p) {
  try { await stat(p); return true } catch { return false }
}

export async function isFile (p) {
  try { return (await stat(p)).isFile() } catch { return false }
}

function stripDot (p) {
  const s = String(p).replace(/\\/g, '/')
  if (s.startsWith('./')) return s.slice(2)
  if (s.startsWith('.\\')) return s.slice(2)
  if (s.startsWith('/')) return s.slice(1)
  return s
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.pi', '.dsh'])

/** @param {string} root @param {number} depth @returns {Promise<string[]>} */
export async function walk (root, depth) {
  const out = []
  let ents = []
  try { ents = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name) || depth <= 1) continue
      out.push(...await walk(path.join(root, e.name), depth - 1))
    } else if (e.isFile()) out.push(path.join(root, e.name))
  }
  return out
}

/**
 * Classify a package directory as a pi package, a DSH bundle, both, or neither.
 * @param {string} dir
 */
export async function classify (dir) {
  let pkg = {}
  try { pkg = await readJson(path.join(dir, 'package.json')) } catch { /* bare directory */ }
  const keywords = (Array.isArray(pkg.keywords) ? pkg.keywords : []).map(String)
  const piByKeyword = keywords.includes('pi-package')
  const dshByKeyword = keywords.includes('dsh-plugin')
  const hasPiManifest = !!(pkg.pi && typeof pkg.pi === 'object')
  const hasDshManifest = !!(pkg.dsh && pkg.dsh.bundle)
  const layoutPi = await hasPiLayout(dir)
  const layoutDsh = await hasDshLayout(dir, pkg)
  const entry = await dshEntry(dir, pkg)
  return {
    dir,
    name: pkg.name || path.basename(dir),
    version: String(pkg.version || '0.0.0'),
    pkg,
    pi: piByKeyword || hasPiManifest || layoutPi,
    dsh: dshByKeyword || hasDshManifest || layoutDsh,
    signals: {
      pi: [piByKeyword && 'keyword:pi-package', hasPiManifest && 'manifest:pi', layoutPi && 'layout:extensions|skills'].filter(Boolean),
      dsh: [dshByKeyword && 'keyword:dsh-plugin', hasDshManifest && 'manifest:dsh.bundle', layoutDsh && 'layout:main'].filter(Boolean),
    },
    dshEntry: entry,
  }
}

async function hasPiLayout (dir) {
  for (const d of ['extensions', 'skills', 'prompts', 'themes']) {
    if (await exists(path.join(dir, d))) return true
  }
  return false
}

async function hasDshLayout (dir, pkg) {
  return !!(await dshEntry(dir, pkg))
}

/** The DSH entry file of a bundle directory, or null. */
export async function dshEntry (dir, pkg) {
  const candidates = []
  const exp = pkg && pkg.exports && pkg.exports['.']
  if (typeof exp === 'string') candidates.push(exp)
  else if (exp && typeof exp === 'object') candidates.push(exp.default || exp.import)
  if (pkg && pkg.main) candidates.push(pkg.main)
  candidates.push('index.js', 'index.mjs', 'index.cjs', 'dist/index.js', 'lib/index.js')
  for (const c of candidates) {
    const p = path.join(dir, stripDot(c))
    if (await isFile(p)) return p
  }
  return null
}

/**
 * Declared pi resources: extension code files and skill directories, from the
 * explicit pi manifest when present, else the conventional directories.
 * @param {string} dir
 * @param {any} pkg
 */
export async function piEntries (dir, pkg) {
  const declared = (pkg && pkg.pi) || {}
  const extensions = []
  const skills = []
  if (Array.isArray(declared.extensions)) {
    for (const item of declared.extensions) extensions.push(...await expand(dir, String(item), ['.ts', '.js', '.mjs', '.cjs']))
  }
  if (Array.isArray(declared.skills)) {
    for (const item of declared.skills) skills.push(...await skillDirsFrom(await expand(dir, String(item), ['.md'])))
  }
  if (!extensions.length) {
    for (const cand of ['extensions/*', 'src/*', 'lib/*']) {
      const found = await expand(dir, cand, ['.ts', '.js', '.mjs'])
      if (found.length) { extensions.push(...found); break }
    }
  }
  if (!extensions.length) {
    for (const cand of ['index.ts', 'index.js', 'main.ts', 'main.js', 'extension.ts', 'extension.js']) {
      const p = path.join(dir, cand)
      if (await isFile(p)) extensions.push(p)
    }
  }
  if (!skills.length) skills.push(...await skillDirsOf(path.join(dir, 'skills')))
  return { extensions: unique(extensions), skills: unique(skills) }
}

async function skillDirsFrom (files) {
  return unique(files.map(f => path.dirname(f)))
}

/** @param {string} root @returns {Promise<string[]>} */
export async function skillDirsOf (root) {
  const out = []
  let ents = []
  try { ents = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    const d = path.join(root, e.name)
    if (await isFile(path.join(d, 'SKILL.md'))) out.push(d)
    else out.push(...await skillDirsOf(d))
  }
  return out
}

/** Resolve a manifest item (file, dir, or dir/glob tail) to concrete files. */
async function expand (dir, item, extensions) {
  const cleaned = stripDot(item)
  const star = cleaned.indexOf('*')
  const base = star >= 0 ? cleaned.slice(0, star).replace(/[/\\][^/\\]*$/, '') : cleaned
  const exact = path.join(dir, cleaned)
  if (star < 0 && await isFile(exact)) return [exact]
  const root = path.join(dir, base)
  if (await isFile(root)) return [root]
  if (!(await exists(root))) {
    // A bare directory name in the manifest ("./extensions"): treat as a dir.
    const alt = path.join(dir, base)
    if (!(await exists(alt))) return []
  }
  const out = []
  for (const f of await walk(root, 3)) if (extensions.some(e => f.endsWith(e))) out.push(f)
  return out
}

function unique (arr) {
  return Array.from(new Set(arr))
}

/** SKILL.md frontmatter: top-level key: value lines only. */
export function parseFrontmatter (text) {
  const out = {}
  if (!text.startsWith('---')) return out
  const end = text.indexOf('\n---', 3)
  if (end < 0) return out
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (m && out[m[1]] === undefined) out[m[1]] = m[2].trim()
  }
  return out
}
