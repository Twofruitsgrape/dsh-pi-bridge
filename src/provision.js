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
import { resolveDsh, dshFailureMessage } from './dsh-launch.js'
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

/**
 * The DSH version this bridge is tested against.
 *
 * Same rule as PI_SPEC. Note it is a release candidate while the desktop build
 * tested elsewhere is 0.2.1-rc.3; the pinned version here is what the CLI
 * publishes, and the difference is recorded in the README's version table rather
 * than papered over.
 */
export const DSH_SPEC = '@deepseek-ai/dsh@0.2.1-rc.2'

/** The npm prefix a provisioned pi lives under: a sibling of the bridge cache. */
export function vendorRoot (env = process.env, home = env.USERPROFILE || env.HOME || os.homedir()) {
  return path.join(home, '.dsh-pi-bridge', 'vendor')
}

/**
 * The exact npm invocation for one runtime, as data so it can be asserted
 * without running it.
 *
 * --omit=dev and --ignore-scripts are the two that matter: the first keeps test
 * scaffolding out of a runtime directory, the second means supplying a runtime
 * cannot run arbitrary install code on the user's machine.
 *
 * @returns {string[]} arguments for npm
 */
export function provisionArgsFor (spec, prefix) {
  return [
    'install',
    '--prefix', prefix,
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    spec,
  ]
}

/** Provisioning arguments for pi, the default direction. */
export function provisionArgs (options = {}) {
  return provisionArgsFor(PI_SPEC, options.prefix || vendorRoot(options.env))
}

/** Provisioning arguments for DSH. */
export function provisionDshArgs (options = {}) {
  return provisionArgsFor(DSH_SPEC, options.prefix || vendorRoot(options.env))
}

/**
 * The one provisioning flow, shared by both directions.
 *
 * Two things are deliberately not generalised away: the refusal code stays
 * specific to the runtime that is missing (a caller may want to react to pi and
 * DSH differently), and the failure message is the resolver's own, so the reason
 * is still the list of places that were actually looked in.
 */
async function provisionMissing (plan) {
  const { resolve, spec, argsFor, failure, code, env, log, run } = plan
  const found = resolve({ env })
  if (found.ok) return { ...found, provisioned: false }

  if (env.DSH_PI_BRIDGE_NO_PROVISION === '1') {
    const err = new Error(failure(found))
    err.code = 'NO_' + code + '_NO_PROVISION'
    throw err
  }

  log('no ' + code.toLowerCase() + ' runtime found; installing ' + spec + ' into ' + vendorRoot(env))
  // Awaited so a caller can substitute a runner that is itself asynchronous -
  // the orchestration is what a test wants to cover, not npm's exit code.
  const result = await run(argsFor({ env }))
  const tail = String((result && (result.stderr || result.stdout)) || '').trim().split('\n').slice(-6).join('\n')

  const after = resolve({ env })
  if (!after.ok) {
    const err = new Error(failure(after) + (tail ? '\nnpm said:\n' + tail : ''))
    err.code = 'PROVISION_FAILED'
    throw err
  }
  log('provisioned ' + code.toLowerCase() + ' ' + (after.version || '?') + ' at ' + after.moduleDir)
  return { ...after, provisioned: true }
}

function defaultRunner () {
  return (args) => spawnSync('npm', args, {
    // npm is a .cmd shim on Windows; every other platform spawns it directly.
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: 600000,
    windowsHide: true,
  })
}

/**
 * A usable pi, or the reason there is none - never a download.
 *
 * For callers whose question is "what is the state of things", where supplying a
 * runtime would answer a diagnostic with a side effect.
 */
export function requirePiRuntime (options = {}) {
  const found = resolvePi({ env: options.env || process.env })
  if (!found.ok) {
    const err = new Error(piFailureMessage(found))
    err.code = 'NO_PI'
    throw err
  }
  return { ...found, provisioned: false }
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
  return provisionMissing({
    resolve: resolvePi, spec: PI_SPEC, argsFor: provisionArgs, failure: piFailureMessage,
    code: 'PI', env, log: options.log || (() => {}), run: options.run || defaultRunner(),
  })
}

/**
 * The same for DSH, so a machine with only pi can run DSH bundles natively
 * instead of replaying them onto stand-ins.
 *
 * @param {{env?:object, log?:function, run?:function}} [options]
 * @returns {Promise<object>}
 */
export async function ensureDshRuntime (options = {}) {
  const env = options.env || process.env
  return provisionMissing({
    resolve: resolveDsh, spec: DSH_SPEC, argsFor: provisionDshArgs, failure: dshFailureMessage,
    code: 'DSH', env, log: options.log || (() => {}), run: options.run || defaultRunner(),
  })
}
