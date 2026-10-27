/**
 * Starting a DSH when the machine only has pi.
 *
 * The other half of the requirement. Until now the pi side could only talk to a
 * DSH the user had already started with DSH_PI_BRIDGE_DSH_SERVE set, which meant
 * "only pi installed" degraded to replaying registrations onto stand-ins - names
 * arrive, behaviour does not. This supplies the missing host instead.
 *
 * The mechanism was measured, not assumed: `@deepseek-ai/dsh` is an ordinary CLI
 * (`dsh --profile <name>`), a profile is a pnpm workspace whose `dsh.profile.
 * bundles` list composes one patch layer per bundle, and a profile booted with
 * DSH_PI_BRIDGE_DSH_SERVE answers /health in about three seconds. So the whole
 * job is: make sure a runtime exists, make sure one profile has the bridge in it,
 * start it detached with that variable set, and wait for the endpoint.
 *
 * Two details are load-bearing and were found the hard way:
 *   - `dsh plugin add` leaves node_modules empty when the source is a `link:` on
 *     another drive, and the plugin manager then fails to resolve the bundle. The
 *     bridge is already on disk, so a junction into the profile is both simpler
 *     and truer than making pnpm agree.
 *   - a dedicated profile name (`pi-host`) is created from the shipped `web`
 *     template, so a user's own profile is never written to.
 *
 * @module src/dsh-supervisor.js
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { dshEndpoint, dshHostStatus } from './dsh-host-client.js'
import { ensureDshRuntime, vendorRoot } from './provision.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_ROOT = path.resolve(HERE, '..')

/** A profile of its own, so no user profile is ever modified. */
export const PROFILE = 'pi-host'
/** The shipped template it is created from. */
export const TEMPLATE = 'web'

let starting = null
let child = null

/**
 * Where a provisioned DSH keeps its own home, separate from a user's.
 *
 * A sibling of `vendor`, not a child of it: vendor holds runtimes, this holds the
 * state one of them accumulates (profiles, pid), and mixing the two makes
 * "delete the runtime" and "delete the state" the same dangerous act.
 */
export function dshHomeDir (env = process.env) {
  return path.join(path.dirname(vendorRoot(env)), 'dsh-home')
}

/**
 * Add the bridge to a profile's bundle list.
 *
 * Pure, so the shape a profile has to end up in can be asserted without booting
 * anything. A `dsh-pi-bridge` dependency entry is removed when present: it is what
 * made the plugin manager try to resolve a package pnpm had not materialised.
 *
 * @param {object} pkg a profile's package.json
 * @returns {object} the package.json it should be
 */
export function withBridgeBundle (pkg) {
  const out = JSON.parse(JSON.stringify(pkg || {}))
  out.dsh = out.dsh || {}
  out.dsh.profile = out.dsh.profile || {}
  const bundles = Array.isArray(out.dsh.profile.bundles) ? out.dsh.profile.bundles.slice() : []
  if (!bundles.includes('dsh-pi-bridge')) bundles.push('dsh-pi-bridge')
  out.dsh.profile.bundles = bundles
  if (out.dependencies) delete out.dependencies['dsh-pi-bridge']
  return out
}

async function runToCompletion (runtime, args, env) {
  return new Promise((resolve) => {
    const p = spawn(runtime.command, [...runtime.args, ...args], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
      windowsHide: true,
      shell: /\.(cmd|bat)$/i.test(runtime.command),
    })
    p.on('exit', (code) => resolve(code))
    p.on('error', () => resolve(-1))
  })
}

/**
 * Create the profile if needed, and make the bridge resolvable inside it.
 * @returns {Promise<string>} the profile directory
 */
export async function ensureProfile (runtime, options = {}) {
  const env = options.env || process.env
  const log = options.log || (() => {})
  const root = options.bridgeRoot || BRIDGE_ROOT
  const home = dshHomeDir(env)
  const profileDir = path.join(home, 'profiles', PROFILE)
  const pkgFile = path.join(profileDir, 'package.json')

  if (!existsSync(pkgFile)) {
    log('creating DSH profile ' + PROFILE + ' from the ' + TEMPLATE + ' template')
    // --dump-config composes the profile without booting an app or serving anything.
    await runToCompletion(runtime, ['--profile', PROFILE, '--from-default-profile', TEMPLATE, '--dump-config'], { DSH_HOME: home })
  }

  const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
  await writeFile(pkgFile, JSON.stringify(withBridgeBundle(pkg), null, 2) + '\n', 'utf8')

  const link = path.join(profileDir, 'node_modules', 'dsh-pi-bridge')
  await mkdir(path.dirname(link), { recursive: true })
  // Re-linked every start: a junction to a moved checkout is a start that fails
  // with a module-not-found from inside DSH, which reads as a bridge bug.
  await rm(link, { recursive: true, force: true })
  await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  return profileDir
}

async function healthOrNull (env, port) {
  try {
    const h = await dshHostStatus({ endpoint: { host: '127.0.0.1', port } })
    return h && h.ok && h.serve ? h : null
  } catch { return null }
}

/**
 * A DSH that serves DSH plugins to this pi, started if one is not already up.
 *
 * @param {{env?:object, log?:function, port?:number, waitMs?:number, bridgeRoot?:string}} [options]
 * @returns {Promise<{port:number, reused:boolean, health:object}>}
 */
export async function ensureDshHost (options = {}) {
  const env = options.env || process.env
  const log = options.log || (() => {})
  const port = options.port || dshEndpoint(env).port
  const waitMs = Math.max(2000, options.waitMs || 40000)

  const live = await healthOrNull(env, port)
  if (live) return { port, reused: true, health: live }

  // Supplying a runtime (a download) and starting one (a long-lived process) are
  // different acts, and a caller may allow one without the other. The suite allows
  // neither: it tests the degraded path, and a host start would both change what
  // is under test and leave a process behind.
  if (env.DSH_PI_BRIDGE_NO_AUTOSTART === '1') {
    const err = new Error('a DSH host would be started here, but DSH_PI_BRIDGE_NO_AUTOSTART=1 forbids it')
    err.code = 'NO_AUTOSTART'
    throw err
  }

  if (starting) return starting
  starting = (async () => {
    const runtime = await ensureDshRuntime({ env, log })
    const home = dshHomeDir(env)
    await ensureProfile(runtime, { env, log, bridgeRoot: options.bridgeRoot })

    // Detached: the host has to outlive the tool call that started it, exactly as
    // the pi daemon outlives the DSH call that started it.
    child = spawn(runtime.command, [...runtime.args, '--profile', PROFILE, '--no-open'], {
      env: { ...process.env, ...env, DSH_HOME: home, DSH_PI_BRIDGE_DSH_SERVE: String(port) },
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      shell: /\.(cmd|bat)$/i.test(runtime.command),
    })
    child.unref()
    const pidFile = path.join(home, 'host.pid')
    await mkdir(home, { recursive: true })
    await writeFile(pidFile, String(child.pid || ''), 'utf8')
    log('started DSH ' + (runtime.version || '?') + ' profile ' + PROFILE + ' pid=' + child.pid + ' serving on 127.0.0.1:' + port)

    const attempts = Math.max(4, Math.round(waitMs / 500))
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const h = await healthOrNull(env, port)
      if (h) return { port, reused: false, health: h }
      if (child && child.exitCode !== null) {
        throw new Error('the DSH host exited with code ' + child.exitCode + ' before serving on ' + port + '; log: ' + path.join(home, 'host.log'))
      }
    }
    throw new Error('the DSH host did not serve on 127.0.0.1:' + port + ' within ' + waitMs + 'ms')
  })().finally(() => { starting = null })
  return starting
}

/** Stop the host this process started, if it is still running. */
export async function stopDshHost (options = {}) {
  const env = options.env || process.env
  const home = dshHomeDir(env)
  try {
    const pid = Number(await readFile(path.join(home, 'host.pid'), 'utf8'))
    if (Number.isFinite(pid) && pid > 0) process.kill(pid)
  } catch { /* nothing recorded, or already gone */ }
  child = null
  await mkdir(home, { recursive: true })
  await appendFile(path.join(home, 'host.log'), '', 'utf8').catch(() => {})
}
