/**
 * Finding pi before anything tries to run it.
 *
 * The daemon used to spawn a bare `pi` and let PATH decide. On a machine where
 * the bridge is installed on the DSH side only, PATH has no pi at all: the spawn
 * failed, the daemon kept waiting for a bootstrap that could never appear, and
 * the caller reported "did not become ready within 45000ms" 45 seconds later.
 * The cause was one lookup away the whole time, so it is looked up first and
 * reported as a sentence the user can act on.
 *
 * Three sources, most specific first:
 *   1. DSH_PI_BRIDGE_PI - an explicit override, trusted as written
 *   2. the pi package itself - @earendil-works/pi-coding-agent, whose own bin
 *      entry runs under this process' node, so a vendored copy works with no
 *      global install and no provider credentials (measured: an empty
 *      PI_CODING_AGENT_DIR still answers get_state, reporting model "unknown")
 *   3. a pi executable on PATH, or in the global npm bin a GUI-launched host
 *      tends to drop from PATH
 *
 * Resolution is pure: existence and reads are injected, so a test can describe a
 * machine that has only one of these without building it.
 *
 * @module src/pi-launch.js
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PI_PACKAGE = path.join('@earendil-works', 'pi-coding-agent')
const DEFAULT_BIN = path.join('dist', 'bundle', 'cli.js')

/** Executable names a pi install can take, cheapest to check first. */
export function piExecutableNames (platform = process.platform) {
  return platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi']
}

/** Where an installed pi package can live, most likely first. */
export function piModuleRoots (env = process.env, platform = process.platform, home = env.USERPROFILE || env.HOME || os.homedir()) {
  const roots = []
  if (platform === 'win32') roots.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'))
  else roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  // A copy the user vendored next to the bridge's own state, so "only DSH
  // installed" stays a supported arrangement rather than a broken one.
  roots.push(path.join(home, '.dsh-pi-bridge', 'vendor', 'node_modules'))
  return roots
}

/** Conventional bin directories, for a host launched without PATH. */
export function piBinDirs (env = process.env, platform = process.platform, home = env.USERPROFILE || env.HOME || os.homedir()) {
  return platform === 'win32'
    ? [path.join(home, 'AppData', 'Roaming', 'npm')]
    : ['/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin')]
}

function hit (command, args, source, version, moduleDir) {
  return { ok: true, command, args, source, version, moduleDir }
}

/**
 * The package directory containing a given file, found by walking up to a
 * package.json whose name is pi's.
 *
 * This is what makes an explicit DSH_PI_BRIDGE_PI as complete as a discovered
 * install: pointing at `dist/bundle/cli.js` used to leave the module directory
 * empty, and the daemon then loaded with "PI_MODULE_DIR unset: cannot load
 * TypeScript extensions" - a vendored runtime that could start but could not run
 * a TypeScript package, which is most of them.
 */
function packageDirOf (file, exists, read) {
  let dir = path.dirname(path.resolve(file))
  for (let i = 0; i < 6; i++) {
    if (exists(path.join(dir, 'package.json'))) {
      try {
        const pkg = JSON.parse(read(path.join(dir, 'package.json')))
        if (typeof pkg.name === 'string' && pkg.name.includes('pi-coding-agent')) return dir
      } catch { /* keep walking */ }
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return ''
}

/**
 * The pi package directory, regardless of how the executable was found.
 *
 * Kept separate from resolvePi because they answer different questions: the
 * executable decides whether pi can start, while this decides which pi's modules
 * jiti and the host-package aliases resolve against. A pi installed globally but
 * absent from PATH still has modules worth aliasing, so the manifest alone
 * qualifies - the bin file does not.
 */
export function findPiModuleDir (options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || env.USERPROFILE || env.HOME || os.homedir()
  const exists = options.exists || existsSync
  if (env.PI_MODULE_DIR && exists(path.join(env.PI_MODULE_DIR, 'package.json'))) return env.PI_MODULE_DIR
  for (const root of piModuleRoots(env, platform, home)) {
    const dir = path.join(root, PI_PACKAGE)
    if (exists(path.join(dir, 'package.json'))) return dir
  }
  return ''
}

/**
 * The package's bin entry, or null when the directory holds no pi manifest.
 * A bin field is either a string or a name→path map; pi publishes the map form.
 */
function binEntry (dir, read) {
  try {
    const pkg = JSON.parse(read(path.join(dir, 'package.json')))
    const bin = pkg.bin
    const rel = typeof bin === 'string' ? bin : bin && (bin.pi || Object.values(bin)[0])
    return { rel: rel || DEFAULT_BIN, version: pkg.version || '' }
  } catch { return null }
}

/**
 * Resolve the pi runtime this machine can actually run.
 *
 * @param {{env?:object, platform?:string, home?:string, exists?:function, read?:function}} [options]
 * @returns {{ok:true, command:string, args:string[], source:string, version:string, moduleDir:string}
 *          |{ok:false, reason:string, searched:string[]}}
 */
export function resolvePi (options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || env.USERPROFILE || env.HOME || os.homedir()
  const exists = options.exists || existsSync
  const read = options.read || ((p) => readFileSync(p, 'utf8'))
  const searched = []

  const override = env.DSH_PI_BRIDGE_PI
  if (override) {
    if (/\.(c|m)?js$/.test(override)) {
      if (exists(override)) {
        // An override names an executable, but pi's modules still have to be
        // found: a vendored copy pointed at this way must be as usable as an
        // installed one, TypeScript extensions included.
        const moduleDir = packageDirOf(override, exists, read)
        const entry = moduleDir ? binEntry(moduleDir, read) : null
        return hit(process.execPath, [override], 'override', (entry && entry.version) || '', moduleDir)
      }
      searched.push('DSH_PI_BRIDGE_PI=' + override + ' (no such file)')
    } else if (!override.includes('/') && !override.includes(path.sep)) {
      // A bare command name the user chose deliberately: taken as given.
      return hit(override, [], 'override', '', '')
    } else if (exists(override)) {
      return hit(override, [], 'override', '', packageDirOf(override, exists, read))
    } else {
      searched.push('DSH_PI_BRIDGE_PI=' + override + ' (no such file)')
    }
  }

  const dirs = []
  if (env.PI_MODULE_DIR) dirs.push(env.PI_MODULE_DIR)
  for (const root of piModuleRoots(env, platform, home)) dirs.push(path.join(root, PI_PACKAGE))
  for (const dir of dirs) {
    const entry = binEntry(dir, read)
    if (!entry) { searched.push(dir + ' (no package.json)'); continue }
    const cli = path.join(dir, entry.rel)
    if (!exists(cli)) { searched.push(cli + ' (missing)'); continue }
    return hit(process.execPath, [cli], 'package', entry.version, dir)
  }

  const sep = platform === 'win32' ? ';' : ':'
  const pathVar = env.PATH || env.Path || ''
  const pathDirs = pathVar.split(sep).filter(Boolean)
  for (const dir of pathDirs) {
    for (const name of piExecutableNames(platform)) {
      const p = path.join(dir, name)
      if (exists(p)) return hit(p, [], 'path', '', '')
    }
  }
  searched.push(pathDirs.length ? 'PATH: ' + pathDirs.length + ' directories' : 'PATH: empty')

  const bins = piBinDirs(env, platform, home)
  for (const dir of bins) {
    for (const name of piExecutableNames(platform)) {
      const p = path.join(dir, name)
      if (exists(p)) return hit(p, [], 'npm-global', '', '')
    }
  }
  searched.push('npm global bin: ' + bins.join(', '))

  return { ok: false, reason: 'no pi runtime found', searched }
}

/**
 * The failure as a message, not a symptom. Every line here is something the
 * user can act on, and the last one is what makes "only DSH installed" a
 * workable setup instead of an unexplained timeout.
 */
export function piFailureMessage (result) {
  return [
    'this side of the bridge needs a pi runtime and none is installed.',
    'looked in:',
    ...result.searched.map((s) => '  - ' + s),
    'fix one of these:',
    '  - install pi:            npm install -g @earendil-works/pi-coding-agent',
    '  - point at a copy:       DSH_PI_BRIDGE_PI=/path/to/pi/dist/bundle/cli.js',
    '  - vendor it for this bridge: npm install --prefix ~/.dsh-pi-bridge/vendor @earendil-works/pi-coding-agent',
    'a vendored copy starts and registers tools with no provider credentials;',
    'only a tool that itself calls a model needs a key.',
  ].join('\n')
}
