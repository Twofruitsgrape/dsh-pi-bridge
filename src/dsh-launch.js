/**
 * Finding DSH before anything tries to run it - the mirror of src/pi-launch.js.
 *
 * The requirement is symmetric: a machine with only pi has to run DSH bundles
 * natively, which means pi has to be able to start a DSH. `@deepseek-ai/dsh` is
 * an ordinary npm package with a real CLI (`lib/bin.js`), so the same three
 * sources apply, in the same order: an explicit override, a package install, a
 * `dsh` on PATH.
 *
 * Resolution is pure - existence and reads are injected - so "a machine that has
 * never installed DSH" is a case a test can state rather than a machine someone
 * has to build.
 *
 * @module src/dsh-launch.js
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DSH_PACKAGE = path.join('@deepseek-ai', 'dsh')
const DEFAULT_BIN = path.join('lib', 'bin.js')

/** Where an installed dsh package can live, most likely first. */
export function dshModuleRoots (env = process.env, platform = process.platform, home = env.USERPROFILE || env.HOME || os.homedir()) {
  const roots = []
  if (platform === 'win32') roots.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'))
  else roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  // The copy this bridge provisions when DSH is not installed at all.
  roots.push(path.join(home, '.dsh-pi-bridge', 'vendor', 'node_modules'))
  return roots
}

/** Executable names a dsh install can take. */
export function dshExecutableNames (platform = process.platform) {
  return platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
}

function binEntry (dir, read) {
  try {
    const pkg = JSON.parse(read(path.join(dir, 'package.json')))
    const bin = pkg.bin
    const rel = typeof bin === 'string' ? bin : bin && (bin.dsh || Object.values(bin)[0])
    return { rel: rel || DEFAULT_BIN, version: pkg.version || '' }
  } catch { return null }
}

function hit (command, args, source, version, moduleDir) {
  return { ok: true, command, args, source, version, moduleDir }
}

/**
 * Resolve a runnable DSH CLI.
 *
 * @param {{env?:object, platform?:string, home?:string, exists?:function, read?:function}} [options]
 * @returns {{ok:true, command:string, args:string[], source:string, version:string, moduleDir:string}
 *          |{ok:false, reason:string, searched:string[]}}
 */
export function resolveDsh (options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || env.USERPROFILE || env.HOME || os.homedir()
  const exists = options.exists || existsSync
  const read = options.read || ((p) => readFileSync(p, 'utf8'))
  const searched = []

  const override = env.DSH_PI_BRIDGE_DSH
  if (override) {
    if (/\.(c|m)?js$/.test(override)) {
      if (exists(override)) return hit(process.execPath, [override], 'override', '', path.dirname(path.dirname(path.resolve(override))))
      searched.push('DSH_PI_BRIDGE_DSH=' + override + ' (no such file)')
    } else if (!override.includes('/') && !override.includes(path.sep)) {
      return hit(override, [], 'override', '', '')
    } else if (exists(override)) {
      return hit(override, [], 'override', '', '')
    } else {
      searched.push('DSH_PI_BRIDGE_DSH=' + override + ' (no such file)')
    }
  }

  const dirs = []
  if (env.DSH_MODULE_DIR) dirs.push(env.DSH_MODULE_DIR)
  for (const root of dshModuleRoots(env, platform, home)) dirs.push(path.join(root, DSH_PACKAGE))
  for (const dir of dirs) {
    const entry = binEntry(dir, read)
    if (!entry) { searched.push(dir + ' (no package.json)'); continue }
    const bin = path.join(dir, entry.rel)
    if (!exists(bin)) { searched.push(bin + ' (missing)'); continue }
    return hit(process.execPath, [bin], 'package', entry.version, dir)
  }

  const sep = platform === 'win32' ? ';' : ':'
  const pathDirs = (env.PATH || env.Path || '').split(sep).filter(Boolean)
  for (const dir of pathDirs) {
    for (const name of dshExecutableNames(platform)) {
      const p = path.join(dir, name)
      if (exists(p)) return hit(p, [], 'path', '', '')
    }
  }
  searched.push(pathDirs.length ? 'PATH: ' + pathDirs.length + ' directories' : 'PATH: empty')

  const bins = platform === 'win32'
    ? [path.join(home, 'AppData', 'Roaming', 'npm')]
    : ['/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin')]
  for (const dir of bins) {
    for (const name of dshExecutableNames(platform)) {
      const p = path.join(dir, name)
      if (exists(p)) return hit(p, [], 'npm-global', '', '')
    }
  }
  searched.push('npm global bin: ' + bins.join(', '))

  return { ok: false, reason: 'no dsh runtime found', searched }
}

/** The DSH package directory, regardless of how the CLI was found. */
export function findDshModuleDir (options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || env.USERPROFILE || env.HOME || os.homedir()
  const exists = options.exists || existsSync
  if (env.DSH_MODULE_DIR && exists(path.join(env.DSH_MODULE_DIR, 'package.json'))) return env.DSH_MODULE_DIR
  for (const root of dshModuleRoots(env, platform, home)) {
    const dir = path.join(root, DSH_PACKAGE)
    if (exists(path.join(dir, 'package.json'))) return dir
  }
  return ''
}

/** The failure as a message a user can act on. */
export function dshFailureMessage (result) {
  return [
    'this side of the bridge needs a DSH runtime and none is installed.',
    'looked in:',
    ...result.searched.map((s) => '  - ' + s),
    'fix one of these:',
    '  - let the bridge supply one:  it installs ' + '@deepseek-ai/dsh into ~/.dsh-pi-bridge/vendor on first use',
    '  - point at a copy:            DSH_PI_BRIDGE_DSH=/path/to/dsh/lib/bin.js',
    '  - install it yourself:        npm install -g @deepseek-ai/dsh',
  ].join('\n')
}
