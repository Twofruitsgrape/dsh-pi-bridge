/**
 * Supplying the other host when it is not installed.
 *
 * The requirement this bridge exists to meet is symmetric: a machine with only
 * DSH has to be able to install pi packages, and a machine with only pi has to be
 * able to install DSH bundles. Neither runtime can be assumed present, so the
 * missing one is fetched into the bridge's own directory instead of into a host's.
 *
 * Three properties make doing that on demand defensible:
 *   - a pinned version, because the package is only tested against one and a
 *     floating range would silently move a working setup onto an untested pi;
 *   - --ignore-scripts, because supplying a runtime must never execute a
 *     package's own install code as a side effect of running a tool;
 *   - it lands under ~/.dsh-pi-bridge/vendor, outside both hosts, so deleting it
 *     cannot damage an installation and an existing pi is never touched.
 *
 * Provisioning is on the path a user already took deliberately (pi_install), not
 * a background action, and DSH_PI_BRIDGE_NO_PROVISION=1 turns it off for a
 * machine that would rather fail than download.
 *
 * @module src/provision.js
 */
import { spawnSync } from 'node:child_process'
import { resolvePi, piFailureMessage } from './pi-launch.js'
import path from 'node:path'
import os from 'node:os'

/**
 * The pi version this bridge is tested against.
 *
 * Kept here rather than as a range so that "which pi did the bridge give me" has
 * one answer, and it matches the tested-versions table in the README. Moving it
 * is a deliberate act that should come with a measurement.
 */
export const PI_SPEC = '@earendil-works/pi-coding-agent@1.4.0'

/** The npm prefix a provisioned pi lives under: a sibling of the bridge cache. */
export function vendorRoot (env = process.env, home = env.USERPROFILE || env.HOME || os.homedir()) {
  return path.join(home, '.dsh-pi-bridge', 'vendor')
}

/**
 * The exact npm invocation, as data so it can be asserted without running it.
 *
 * --omit=dev and --ignore-scripts are the two that matter: the first keeps test
 * scaffolding out of a runtime directory, the second means supplying a runtime
 * cannot run arbitrary install code on the user's machine.
 *
 * @returns {string[]} arguments for npm
 */
export function provisionArgs (options = {}) {
  const prefix = options.prefix || vendorRoot(options.env)
  return [
    'install',
    '--prefix', prefix,
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    PI_SPEC,
  ]
}

/**
 * Ensure a usable pi exists, provisioning one only when nothing else answers.
 *
 * Resolves to the same shape resolvePi returns, plus `provisioned` so a caller
 * can tell the user that a download happened rather than that pi was always there.
 *
 * @param {{env?:object, log?:function, run?:function}} [options]
 * @returns {Promise<object>}
 */
export async function ensurePiRuntime (options = {}) {
  const env = options.env || process.env
  const log = options.log || (() => {})
  const run = options.run || ((args) => spawnSync('npm', args, {
    // npm is a .cmd shim on Windows; every other platform spawns it directly.
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: 600000,
    windowsHide: true,
  }))

  const found = resolvePi({ env })
  if (found.ok) return { ...found, provisioned: false }

  if (env.DSH_PI_BRIDGE_NO_PROVISION === '1') {
    const err = new Error(piFailureMessage(found))
    err.code = 'NO_PI_NO_PROVISION'
    throw err
  }

  const args = provisionArgs({ env })
  log('no pi runtime found; installing ' + PI_SPEC + ' into ' + vendorRoot(env))
  // Awaited so a caller can substitute a runner that is itself asynchronous -
  // the orchestration is what a test wants to cover, not npm's exit code.
  const result = await run(args)
  const tail = String((result && (result.stderr || result.stdout)) || '').trim().split('\n').slice(-6).join('\n')

  const after = resolvePi({ env })
  if (!after.ok) {
    const err = new Error(piFailureMessage(after) + (tail ? '\nnpm said:\n' + tail : ''))
    err.code = 'PROVISION_FAILED'
    throw err
  }
  log('provisioned pi ' + (after.version || '?') + ' at ' + after.moduleDir)
  return { ...after, provisioned: true }
}
