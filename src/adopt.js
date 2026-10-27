/**
 * Taking over DSH plugins that were installed into pi as ordinary packages.
 *
 * A DSH bundle installed with `pi install npm:<pkg>` sits inert: it has no `pi`
 * manifest, so pi loads nothing and the plugin looks broken. Requiring a second
 * "convert" command per plugin is the friction this removes - and pi offers no
 * install hook to hang that on, so the scan happens at startup instead.
 *
 * What it does is deliberately small: a manifest entry and one file, written into
 * the package that is already installed. No second package, no copy of the bundle,
 * nothing to keep in sync - the plugin keeps living where pi put it, which is also
 * why it appears in pi's plugin list and can be switched off there.
 *
 * The scan is offline by design: it reads manifests and writes files only when a
 * package actually needs adopting. Nothing here downloads or boots anything; the
 * host a plugin needs is started by the generated adapter, at the moment pi loads
 * an extension rather than at the moment pi starts.
 *
 * @module src/adopt.js
 */
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { extensionSource } from './convert.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_ROOT = path.resolve(HERE, '..')

/** Where pi keeps its own state. */
export function piHome (env = process.env, home = env.USERPROFILE || env.HOME || os.homedir()) {
  return path.join(home, '.pi', 'agent')
}

/** The adapter directory written inside an adopted package. */
export const ADAPTER_DIR = 'dsh-pi-bridge-adapter'

/**
 * Resolve one entry of `packages` in settings.json to a directory.
 *
 * pi stores local packages as paths relative to the settings file, so a bare
 * `npm:`/`git:` prefix and a filesystem path are genuinely different cases; a
 * resolver that guessed would adopt the wrong directory and say nothing.
 */
export function entryDir (entry, settingsDir, home) {
  const raw = typeof entry === 'string' ? entry : (entry && entry.source) || ''
  if (!raw) return ''
  if (raw.startsWith('npm:')) {
    const name = raw.slice(4).split('@')[0] || raw.slice(4)
    return path.join(piHome(process.env, home), 'npm', 'node_modules', name)
  }
  if (raw.startsWith('git:')) {
    const rest = raw.slice(4).replace(/^https?:\/\//, '').replace(/\.git$/, '')
    const [host, ...parts] = rest.split('/')
    return path.join(piHome(process.env, home), 'git', host, ...parts)
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const rest = raw.replace(/^https?:\/\//, '').replace(/\.git$/, '')
    const [host, ...parts] = rest.split('/')
    return path.join(piHome(process.env, home), 'git', host, ...parts)
  }
  return path.resolve(settingsDir, raw)
}

/** True for a bundle pi would load nothing from: a dsh manifest and no pi one. */
export function needsAdapter (pkg) {
  if (!pkg || typeof pkg !== 'object') return false
  const isDsh = !!(pkg.dsh && (pkg.dsh.bundle || pkg.dsh.profile || pkg.keywords?.includes('dsh-plugin')))
  return isDsh && !pkg.pi
}

/**
 * Write the adapter into one package and point its manifest at it.
 *
 * Idempotent: a package already carrying the manifest entry and an adapter file is
 * left untouched, so a startup that adopts nothing costs one read per package.
 *
 * @returns {Promise<{changed:boolean, dir:string, reason?:string}>}
 */
export async function adoptOne (dir, options = {}) {
  const pkgFile = path.join(dir, 'package.json')
  if (!existsSync(pkgFile)) return { changed: false, dir, reason: 'no package.json' }
  let pkg
  try { pkg = JSON.parse(await readFile(pkgFile, 'utf8')) } catch { return { changed: false, dir, reason: 'unreadable package.json' } }
  if (!needsAdapter(pkg)) return { changed: false, dir, reason: 'already a pi package, or not a DSH bundle' }

  const adapterDir = path.join(dir, ADAPTER_DIR)
  await mkdir(adapterDir, { recursive: true })
  await writeFile(path.join(adapterDir, 'index.mjs'), extensionSource({
    bundleName: pkg.name || path.basename(dir),
    prefix: options.prefix || '',
    bridgeRoot: options.bridgeRoot || BRIDGE_ROOT,
    source: options.source || dir,
  }), 'utf8')

  // Point at the file, not the directory. Measured: a directory entry only
  // resolves when it holds `index.js` or `index.ts`; ours has to be `.mjs`
  // (the host package's own `type` is not ours to change), and a directory
  // holding only `index.mjs` is silently not an extension at all.
  pkg.pi = { ...(pkg.pi || {}), extensions: [...(pkg.pi?.extensions || []), './' + ADAPTER_DIR + '/index.mjs'] }
  await writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  return { changed: true, dir }
}

/**
 * Adopt every installed package that needs it.
 *
 * @param {{env?:object, log?:function, home?:string, bridgeRoot?:string}} [options]
 * @returns {Promise<{adopted:string[], skipped:string[]}>}
 */
export async function adoptInstalled (options = {}) {
  const env = options.env || process.env
  const log = options.log || (() => {})
  const home = options.home || env.USERPROFILE || env.HOME || os.homedir()
  const settingsFile = path.join(piHome(env, home), 'settings.json')
  const adopted = []
  const skipped = []
  let settings
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')) } catch { return { adopted, skipped } }

  for (const entry of settings.packages || []) {
    const dir = entryDir(entry, path.dirname(settingsFile), home)
    if (!dir) continue
    try { if (!(await stat(dir)).isDirectory()) continue } catch { continue }
    const r = await adoptOne(dir, { ...options, bridgeRoot: options.bridgeRoot || BRIDGE_ROOT })
    if (r.changed) { adopted.push(r.dir); log('adopted ' + r.dir) }
    else skipped.push(r.dir)
  }
  return { adopted, skipped }
}
