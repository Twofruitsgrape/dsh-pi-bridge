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
import { mkdir, rename, rm, cp, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { extractTgz } from './tar.js'
import { ensureSelfReference } from './self-ref.js'

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
  /**
   * A refresh must survive a cache copy that cannot be deleted.
   *
   * On Windows a directory stops being deletable the moment another process has
   * read files out of it - and the pi daemon loads packages from exactly this
   * directory, then stays alive. So refreshing an installed package threw
   * EBUSY and the whole install failed: the user could not reinstall anything
   * while the daemon was up, which is whenever the daemon was up. Retire the
   * locked copy under a new name and fetch into a fresh directory instead.
   */
  try {
    await rm(dest, { recursive: true, force: true })
  } catch (e) {
    if (!e || e.code !== 'EBUSY') throw e
    const retired = dest + '.stale-' + Date.now()
    try { await rename(dest, retired); log('previous copy was locked; moved aside as ' + path.basename(retired)) }
    catch (mv) { throw new Error('cannot replace the cached copy of this package (' + (mv && mv.code) + '); stop the pi daemon (bridge_status shows its pid) and retry') }
  }
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
  const requested = path.resolve(id)
  // A bundle the plugin manager installed is a symlink into plugin-sources. Copy
  // the tree it points at, not the link: node:fs cp reported 'Cannot overwrite
  // directory with non-directory' on two real bundles read this way.
  let src = requested
  try { if ((await lstat(requested)).isSymbolicLink()) src = await realpath(requested) } catch { /* as asked */ }
  log('local: ' + src + (src !== requested ? ' (linked)' : ''))
  await readdir(src).catch(() => { throw new Error('not a directory: ' + src) })
  // A stale copy of an earlier version must not be merged over: cp cannot replace
  // a directory with a file, and files the package dropped would survive and still
  // be imported by the rewritten bundle.
  await rm(dest, { recursive: true, force: true }).catch(() => {})
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
  return /(^|[/])(\.git|node_modules|\.tmp|_dsh_pi_bridge|[.][a-z0-9-]*cache)([/]|$)/.test('/' + rel)
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
  if (!deps.length) { await ensureSelfReference(dir, note); return { status: 'none' } }

  const nm = path.join(dir, 'node_modules')
  await purgePlaceholders(nm, deps)
  // Counting top-level entries is not evidence that the dependencies are there.
  // A scoped name occupies a single directory, so two @scope/* dependencies read as
  // one present entry, and the forwarding package written below adds another - the
  // combination let a half-installed bundle look complete and skip the install,
  // which a live load then reported as a missing package. Ask for each name.
  const missing = await missingDependencies(nm, deps)
  if (!missing.length) {
    // The warm-cache path has to write the forwarding package too: skipping it
    // made a bundle that imports itself load once and fail on every reload.
    await ensureSelfReference(dir, note)
    return { status: 'installed', count: deps.length, reason: 'already present' }
  }

  const args = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps']
  note('npm install (' + deps.length + ' dependencies) in ' + path.basename(dir))
  /**
   * Run the install, keeping the tail of npm's own output.
   *
   * stdio was discarded, so a failed install could only ever be reported as
   * 'npm exited 1' - and npm's exit code is rarely the reason. What the user and
   * I needed was the line saying ERESOLVE, or ENOTFOUND, or which package 404s.
   * A large dependency tree also gets killed by the budget below (12 packages of
   * langchain/qdrant/deepagents did), and without a named cause that looks like a
   * broken bridge rather than a slow install.
   */
  // Measured: npm took 6 minutes for one published pi package's tree
  // (langchain + langgraph + qdrant + deepagents, 180 packages). A five-minute
  // budget made that install fail by construction, so the default covers the
  // slowest tree actually observed here rather than a round number.
  const INSTALL_BUDGET_MS = Number(process.env.DSH_PI_BRIDGE_INSTALL_MS || 900000)
  /**
   * Run one npm install, keeping the tail of its output.
   *
   * Both passes need the same thing: npm's exit code is rarely the reason, and
   * the first version of this captured output for the initial install only, which
   * the self-test caught as a leftover stdio: 'ignore' on the retry.
   *
   * @param {string[]} npmArgs
   * @param {number} budgetMs
   */
  const npmRun = (npmArgs, budgetMs) => new Promise((done) => {
    const isWin = process.platform === 'win32'
    // npm is a .cmd shim on Windows: spawning it without a shell is EINVAL.
    const child = spawn('npm', npmArgs, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], shell: isWin, windowsHide: true })
    let tail = ''
    const keep = (chunk) => { tail = (tail + String(chunk)).slice(-1400) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* gone */ }
    }, budgetMs)
    child.on('error', (e) => { clearTimeout(timer); done({ code: 'spawn:' + (e && e.code), tail, timedOut }) })
    child.on('close', (c) => { clearTimeout(timer); done({ code: c, tail, timedOut }) })
  })
  const install = await npmRun(args, INSTALL_BUDGET_MS)
  const code = install.code
  /**
   * What to append to a failure reason so it names a cause.
   *
   * 'npm exited null' told a user nothing. null means killed, and what killed it
   * was this module's own budget - that has to be said, because the bridge is the
   * thing that gave up, not the registry. Otherwise the last few npm lines are the
   * useful part, since npm's exit code is rarely the reason.
   */
  const suffix = (info) => {
    const bits = []
    if (info.timedOut) bits.push('killed after ' + Math.round(INSTALL_BUDGET_MS / 1000) + 's (raise DSH_PI_BRIDGE_INSTALL_MS for a large dependency tree)')
    const why = (info.tail || '').split('\n').map((l) => l.trim()).filter((l) => l && !/npm warn|trace-warnings|ExperimentalWarning/.test(l)).slice(-2).join(' | ')
    if (why) bits.push('npm said: ' + why.slice(0, 220))
    return bits.length ? ' (' + bits.join('; ') + ')' : ''
  }


  let stillMissing = await missingDependencies(nm, deps)
  // A bridge cache copy can arrive with npm state from an earlier build (its
  // .package-lock.json). npm then reconciles that tree instead of installing what
  // the manifest asks for, exited 0, and left one declared dependency absent - so
  // a plain second pass has to name the missing packages rather than trust the
  // lockfile's idea of "up to date".
  if (stillMissing.length) {
    note('npm left ' + stillMissing.join(', ') + ' out; installing those by name')
    const retry = await npmRun(['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', ...stillMissing], INSTALL_BUDGET_MS)
    stillMissing = await missingDependencies(nm, deps)
    if (stillMissing.length) note('retry (npm ' + retry.code + ') still missing: ' + stillMissing.join(', ') + suffix(retry))
  }
  await ensureSelfReference(dir, note)
  if (!stillMissing.length) return { status: 'installed', count: deps.length, reason: 'all present by name' }
  if (stillMissing.length < deps.length) {
    return { status: 'partial', count: deps.length, reason: 'npm exited ' + code + ', missing ' + stillMissing.join(', ') + suffix(install) }
  }
  return { status: 'failed', count: deps.length, reason: 'npm exited ' + code + suffix(install) }
}

/**
 * Which declared dependencies are not actually installed.
 *
 * A directory is not enough: it must carry a package.json with the expected name,
 * so a stray folder or an empty scope directory does not read as satisfied.
 *
 * @param {string} nm node_modules directory
 * @param {string[]} deps declared dependency names
 */
export async function missingDependencies (nm, deps) {
  const missing = []
  for (const dep of deps) {
    try {
      const inner = JSON.parse(await readFile(path.join(nm, ...String(dep).split('/'), 'package.json'), 'utf8'))
      if (inner && inner.name) continue
      missing.push(dep)
    } catch {
      missing.push(dep)
    }
  }
  return missing
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
