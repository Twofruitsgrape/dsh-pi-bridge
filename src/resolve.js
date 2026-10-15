/**
 * Source resolution: turn a user-supplied spec into a directory on disk.
 *
 * Both hosts speak the same dialect for npm and git (pi: npm:pkg / git:owner/
 * repo / ./path; DSH: the same shapes through its plugin manager), so the
 * bridge accepts one grammar and implements it directly: registry tarball for
 * npm, a shallow clone for git, a path copy or in-place read for local.
 *
 * Everything is downloaded under the bridge's own cache directory so a bridged
 * package never pollutes either host's configuration, and a re-resolve of the
 * same spec is free.
 *
 * @module src/resolve.js
 */
import { mkdir, rm, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { extractTgz } from './tar.js'

export const CACHE_ROOT = process.env.DSH_PI_BRIDGE_HOME
  ? path.resolve(process.env.DSH_PI_BRIDGE_HOME)
  : path.join(os.homedir(), '.dsh-pi-bridge')
export const PACKAGES_DIR = path.join(CACHE_ROOT, 'packages')

const registry = () => process.env.DSH_PI_BRIDGE_REGISTRY || 'https://registry.npmjs.org'

/**
 * Parse one spec into a structured source.
 * @param {string} spec
 */
export function parseSpec (spec) {
  const raw = String(spec || '').trim()
  if (!raw) throw new Error('empty source: give npm:<pkg>[@ver], git:github.com/<owner>/<repo>[@ref], github:<owner>/<repo>, a URL, or a local path')
  if (/^npm:/i.test(raw)) return { type: 'npm', id: raw.slice(4) }
  if (/^git:/i.test(raw)) return { type: 'git', id: raw.slice(4) }
  if (/^(github:|gitlab:|bitbucket:)/i.test(raw)) {
    const i = raw.indexOf(':')
    return { type: 'git', host: raw.slice(0, i), id: raw.slice(i + 1) }
  }
  if (/^https?:\/\//i.test(raw)) {
    if (/github\.com\//i.test(raw)) return { type: 'git', host: 'github', id: raw.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '') }
    return { type: 'url', id: raw }
  }
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('.') || raw.startsWith('~')) {
    return { type: 'local', id: raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw }
  }
  // Bare name: treat as npm package, which is what both markets show.
  if (!/^(@[^/@\s]+\/)?[^/\s@][^\s]*$/.test(raw)) throw new Error('unrecognised source: ' + raw)
  return { type: 'npm', id: raw }
}

/** Deterministic cache directory name for a spec. */
function slugFor (source) {
  return source.id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_|_$/g, '').slice(0, 90) || 'package'
}

/**
 * @param {string} spec
 * @param {{log?:(m:string)=>void, refresh?:boolean}} [options]
 * @returns {Promise<{dir:string, source:any, from:string}>}
 */
export async function resolve (spec, options) {
  const log = (options && options.log) || (() => {})
  const source = parseSpec(spec)
  const dest = path.join(PACKAGES_DIR, source.type + '__' + slugFor(source))
  if (!options || !options.refresh) {
    if (await hasManifest(dest)) return { dir: dest, source, from: 'cache' }
    // Restore-on-load must not reach the network: a host would wait on a
    // download before it could serve the first message. Cache-missing bridges
    // simply report themselves and install on the next explicit use.
    if (options && options.cacheOnly) throw new Error('not in bridge cache')
  }
  await mkdir(PACKAGES_DIR, { recursive: true })
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  switch (source.type) {
    case 'npm': await fromNpm(source.id, dest, log); break
    case 'git': await fromGit(source, dest, log); break
    case 'url': await fromUrl(source.id, dest, log); break
    default: await fromLocal(source.id, dest, log)
  }
  return { dir: dest, source, from: source.type }
}

async function hasManifest (dir) {
  try { await readFile(path.join(dir, 'package.json'), 'utf8'); return true } catch { return false }
}

async function fromNpm (id, dest, log) {
  const versioned = /@[^/]+$/.test(id) || /@\d/.test(id) ? id : id + '@latest'
  const name = versioned.replace(/@[^@]*$/, '')
  log('npm: ' + versioned)
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name
  const meta = JSON.parse(await fetchText(registry() + '/' + encoded))
  const wanted = versioned === name + '@latest' ? (meta['dist-tags'] && meta['dist-tags'].latest) : versioned.slice(name.length + 1)
  const entry = (meta.versions || {})[wanted] || (meta['dist-tags'] && meta['dist-tags'].latest && (meta.versions || {})[meta['dist-tags'].latest])
  if (!entry || !entry.dist || !entry.dist.tarball) throw new Error('no tarball for ' + versioned)
  const tgz = path.join(dest, '.package.tgz')
  await writeFile(tgz, Buffer.from(await fetchBytes(entry.dist.tarball)))
  const { extractTgz: extract } = await import('./tar.js')
  await extract(tgz, dest)
  await rm(tgz, { force: true })
}

async function fromGit (source, dest, log) {
  const host = source.host === 'gitlab' ? 'gitlab.com' : source.host === 'bitbucket' ? 'bitbucket.org' : 'github.com'
  const id = source.id.replace(/@[^@/]+$/, '')
  const url = 'https://' + host + '/' + id + '.git'
  log('git: ' + url)
  await run('git', ['clone', '--depth', '1', url, dest])
  const ref = source.id.slice(id.length + 1)
  if (ref) { try { await run('git', ['checkout', ref], dest) } catch { /* tag may be absent */ } }
  await rm(path.join(dest, '.git'), { recursive: true, force: true })
}

async function fromUrl (url, dest, log) {
  log('url: ' + url)
  if (/\.tgz$/i.test(url) || /\.tar\.gz$/i.test(url)) {
    const tgz = path.join(dest, '.package.tgz')
    await writeFile(tgz, Buffer.from(await fetchBytes(url)))
    await extractTgz(tgz, dest)
    await rm(tgz, { force: true })
    return
  }
  await fromGit({ host: 'github', id: url.replace(/^https?:\/\//i, '').replace(/\.git$/i, '') }, dest, log)
}

async function fromLocal (id, dest, log) {
  const src = path.resolve(id)
  log('local: ' + src)
  await readdir(src).catch(() => { throw new Error('not a directory: ' + src) })
  // cp rejects a destination inside its source before consulting any filter, so
  // a self-bridged package (cache within the package) is copied by hand.
  if (isWithin(src, dest)) { await copyTree(src, dest, 0); return }
  await cp(src, dest, { recursive: true, filter: (t) => !isExcluded(String(t), src) })
}

/**
 * Directory or file names that never travel into a mirror, tested against the
 * path relative to the copy's source root.
 */
function isExcluded (target, root) {
  const rel = (root ? path.relative(String(root), String(target)) : String(target)).replace(/\\/g, '/')
  if (rel.startsWith('..')) return true
  return /(^|[/])(\.git|node_modules|_dsh_pi_bridge|[.][a-z0-9-]*cache)([/]|$)/.test('/' + rel)
}

/** Recursive copy that skips excluded subtrees and its own destination. */
async function copyTree (src, dest, depth) {
  if (depth > 12) return
  await mkdir(dest, { recursive: true })
  let entries = []
  try { entries = await readdir(src, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (isExcluded(from, src) || isWithin(from, dest)) continue
    if (e.isDirectory()) await copyTree(from, to, depth + 1)
    else if (e.isFile()) { try { await cp(from, to) } catch { /* unreadable entry */ } }
  }
}

/** True when child sits inside parent. */
function isWithin (parent, child) {
  const a = path.resolve(parent).replace(/\\/g, '/').replace(/\/+$/, '')
  const b = path.resolve(String(child)).replace(/\\/g, '/')
  return b === a || b.startsWith(a + '/')
}

async function pathExists (p) {
  try { await readFile(p); return true } catch { return false }
}

function run (command, args, cwd) {
  return new Promise((resolve_, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let err = ''
    child.stderr.on('data', d => { err += d.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve_()
      else reject(new Error(command + ' failed (' + code + '): ' + err.slice(0, 300)))
    })
  })
}

async function fetchText (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url)
  return res.text()
}

async function fetchBytes (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Install a package's own published dependencies into its directory.
 *
 * This is the difference between a bridged package that works and one that dies
 * on its first call: a package imports real libraries (undici, typebox helpers,
 * yaml), and if they are absent nothing the bridge registers can run. Both paths
 * use it - the proxy before loading, and the replay mirror before capture - so
 * the behaviour cannot drift between them.
 *
 * Status values are contractual: callers must surface 'failed' and 'partial'
 * rather than continue and let a tool break silently.
 *
 * @param {string} dir package root (the cache copy, never the user's source)
 * @param {(m:string)=>void} [log]
 * @returns {Promise<{status:'none'|'installed'|'partial'|'failed', count?:number, reason?:string}>}
 */
export async function installDependencies (dir, log) {
  const note = log || (() => {})
  let pkg = null
  try { pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) } catch { return { status: 'none' } }
  const deps = Object.keys((pkg && pkg.dependencies) || {})
  if (!deps.length) return { status: 'none' }

  const nm = path.join(dir, 'node_modules')
  await purgePlaceholders(nm, deps)
  const present = await readdir(nm).then((e) => e.filter((n) => !n.startsWith('.') && !n.startsWith('_')).length).catch(() => 0)
  if (present >= deps.length) return { status: 'installed', count: deps.length, reason: 'already present' }

  const args = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps']
  note('npm install (' + deps.length + ' dependencies) in ' + path.basename(dir))
  const code = await new Promise((done) => {
    const isWin = process.platform === 'win32'
    // npm is a .cmd shim on Windows: spawning it without a shell is EINVAL.
    const child = spawn('npm', args, { cwd: dir, stdio: 'ignore', shell: isWin, windowsHide: true })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 300000)
    child.on('error', (e) => { clearTimeout(timer); done('spawn:' + (e && e.code)) })
    child.on('close', (c) => { clearTimeout(timer); done(c) })
  })

  const after = await readdir(nm).then((e) => e.filter((n) => !n.startsWith('.') && !n.startsWith('_')).length).catch(() => 0)
  if (code === 0) return { status: 'installed', count: deps.length, reason: after + ' dirs' }
  if (after > 0) return { status: 'partial', count: deps.length, reason: 'npm exited ' + code + ', ' + after + ' dirs present' }
  return { status: 'failed', count: deps.length, reason: 'npm exited ' + code }
}

/**
 * Remove placeholder packages an earlier build wrote into node_modules.
 *
 * A placeholder holds the directory a real dependency needs: npm then sees the
 * tree populated and skips installing, while the import resolves to an empty
 * stub - which is how a working package failed with "is not a function". Only
 * entries carrying our own marker version are touched.
 */
export async function purgePlaceholders (nm, deps) {
  for (const dep of deps) {
    const one = await import('node:fs/promises')
    const manifest = path.join(nm, ...dep.split('/'), 'package.json')
    try {
      const raw = JSON.parse(await one.readFile(manifest, 'utf8'))
      const v = String(raw.version || '')
      if (v.includes('bridge-missing') || v.includes('dsh-pi-bridge')) {
        await one.rm(path.join(nm, ...dep.split('/')), { recursive: true, force: true })
      }
    } catch { /* absent: nothing to purge */ }
  }
}
