/**
 * The proxy client: what DSH uses to reach a pi package.
 *
 * A bridged package is materialized (source fetched, its own dependencies
 * installed) and then loaded by a supervised pi process through the bootstrap.
 * The bridge never imports or translates the package's code, so pi's genuine
 * ExtensionAPI, typebox, model registry, credentials and ctx.ui are what the
 * package actually sees - which is why a bridged tool behaves the same as it does
 * for a pi user. No stubs are involved on this path.
 *
 * @module src/proxy.js
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve as resolveSource, installDependencies, CACHE_ROOT } from './resolve.js'
import { ensurePiRuntime, requirePiRuntime } from './provision.js'
import { classify, piEntries } from './manifest.js'
import { buildFingerprint } from './build-id.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RUNNER = path.join(ROOT, 'daemon', 'run.mjs')
const PORT = Number(process.env.DSH_PI_BRIDGE_DAEMON_PORT || 43117)
const LOG = path.join(CACHE_ROOT, 'daemon.log')

/**
 * This bridge's own version, so a daemon left running by an older build can be
 * recognised. The daemon is deliberately long-lived (it survives a host restart),
 * which means after an upgrade it would answer health happily while executing the
 * previous version's code - and any verification run would test the wrong build.
 */
const OUR_VERSION = buildFingerprint(ROOT)

let child = null
let starting = null

function request (method, route, body, ms = 30000) {
  return new Promise((res, rej) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method, agent: false,
      timeout: ms, headers: { 'content-type': 'application/json' },
    }, (r) => {
      let raw = ''
      r.on('data', (c) => { raw += c })
      r.on('end', () => { try { res(JSON.parse(raw)) } catch (e) { rej(new Error('bad daemon reply: ' + raw.slice(0, 160))) } })
    })
    req.on('timeout', () => req.destroy(new Error('daemon timeout on ' + route)))
    req.on('error', rej)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

/** Best-effort diagnostics: a log that cannot be written must not fail a call. */
async function record (line) {
  try {
    await mkdir(path.dirname(LOG), { recursive: true })
    await appendFile(LOG, line, 'utf8')
  } catch { /* unwritable cache: drop the diagnostic */ }
}

async function health (ms = 4000) { return request('GET', '/health', null, ms) }

/**
 * Decide how to launch the daemon, given the environment it is launched from.
 *
 * Inside a host process process.execPath is the application binary, not node, so
 * spawning it with a script argument starts another copy of the app instead of
 * running the script. Electron honours ELECTRON_RUN_AS_NODE to act as node, so
 * that is added when the parent is Electron. A GUI-launched host may also carry a
 * PATH without the global npm bin where pi lives, which would make the daemon's
 * own spawn of pi fail, so pi's directory is appended when found.
 *
 * Exported for tests: this decision is invisible to a plain-node test run and
 * only bites inside a host.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @param {boolean} [isElectron] injectable so tests can cover the host case
 * @returns {{command:string, args:string[], env:Record<string,string>}}
 */
export function daemonLaunch (env = process.env, platform = process.platform, isElectron = !!process.versions.electron) {
  const sep = platform === 'win32' ? ';' : ':'
  const home = env.USERPROFILE || env.HOME || os.homedir()
  const candidates = platform === 'win32'
    ? [path.join(home, 'AppData', 'Roaming', 'npm')]
    : ['/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin')]
  const extra = candidates.filter((d) => {
    for (const n of ['pi.cmd', 'pi']) { try { if (existsSync(path.join(d, n))) return true } catch { /* skip */ } }
    return false
  })

  const out = {}
  const command = env.DSH_PI_BRIDGE_NODE || process.execPath
  if (isElectron) out.ELECTRON_RUN_AS_NODE = '1'
  if (extra.length) {
    const current = env.PATH || env.Path || ''
    const have = new Set(current.split(sep).filter(Boolean))
    const add = extra.filter((d) => !have.has(d))
    if (add.length) out.PATH = current ? add.join(sep) + sep + current : add.join(sep)
  }
  return { command, args: [RUNNER, '--packages', '[]', '--port', String(PORT)], env: out }
}

/**
 * Start the daemon unless it is already answering. Resolves once the bootstrap
 * inside pi reports a captured extension context, because nothing can be called
 * before that.
 * @param {{log?:(m:string)=>void}} [options]
 */
/**
 * @param {{log?:(m:string)=>void, waitMs?:number}} [options]
 *        waitMs bounds how long to wait for the bootstrap to report a context.
 *        Restoring at host start uses a short budget: if pi cannot be started
 *        here, waiting 45 seconds per bridge would stall the host for minutes
 *        before the first message, and the user can still install explicitly.
 */
/** True when the daemon reports a bridge version other than this one. */
export function isStaleDaemon (reply, ourVersion = OUR_VERSION) {
  if (!reply || !reply.ok) return false
  // A reply with no stamp predates fingerprinting at all, so it is certainly older.
  if (!ourVersion) return false
  return reply.bridgeVersion !== ourVersion
}

/** Ask a running daemon to exit so this build can start in its place. */
async function retireDaemon (log, h) {  log('restarting the pi daemon: it runs bridge ' + (h.bridgeVersion || 'unversioned') + ', this is ' + OUR_VERSION)
  try { await request('GET', '/shutdown', null, 8000) } catch { /* already gone */ }
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500))
    // Port free again: the old process is gone.
    try { await health(1500) } catch { return }
  }
}

/**
 * Stop the daemon and let this process exit.
 *
 * A status check has a side effect nobody asked for: ensureDaemon starts a pi
 * daemon, and the spawned child's piped stdio keeps the parent's event loop
 * alive. The published self-host check calls every tool the bridge exports,
 * bridge_status included, so it finished its assertions and then never exited -
 * the suite read as a hang rather than a verdict. Asking the daemon to go and
 * releasing the pipes is what makes shutdown observable.
 *
 * @param {number} [ms] how long to wait for /shutdown to be accepted
 * @returns {Promise<boolean>} true when the port stopped answering
 */
export async function stopDaemon (ms = 8000) {
  try { await request('GET', '/shutdown', null, ms) } catch { /* nothing listening */ }
  if (child) {
    try { child.stdout.destroy() } catch { /* already closed */ }
    try { child.stderr.destroy() } catch { /* already closed */ }
  }
  for (let i = 0; i < 20; i++) {
    try { await health(800) } catch { child = null; return true }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

export async function ensureDaemon (options) {
  const log = (options && options.log) || (() => {})
  const budgetMs = Math.max(2000, Number((options && options.waitMs) || 45000))
  try {
    const h = await health()
    if (h && h.ok && !isStaleDaemon(h)) return h
    if (h && h.ok) await retireDaemon(log, h)
  } catch { /* not running */ }
  if (starting) return starting
  starting = (async () => {
    await record('\n[' + new Date().toISOString() + '] starting daemon\n')
    // A machine that installed only the DSH side is a supported arrangement, not
    // an error: the pi runtime the daemon supervises is supplied here, before
    // anything is spawned, which is what keeps the user out of the "did not become
    // ready" class of failure entirely. A status question is different - it is
    // asked precisely when something looks wrong, and answering it by downloading
    // 139MB would make the diagnostic the event - so it refuses instead.
    const runtime = options && options.provision === false
      ? requirePiRuntime()
      : await ensurePiRuntime({ log: (m) => { log(m); void record('runtime: ' + m + '\n') } })
    void record('pi runtime: ' + runtime.source + ' ' + (runtime.version || '?') + (runtime.provisioned ? ' (provisioned)' : '') + '\n')
    const launch = daemonLaunch()
    child = spawn(launch.command, launch.args, {
      cwd: ROOT, detached: false, windowsHide: true,
      // A daemon that dies at once is undiagnosable with its output discarded,
      // which is exactly how a host-side failure stayed opaque. Pipe both streams
      // into the same log the parent already writes.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.env, DSH_PI_BRIDGE_IDLE_MS: String(10 * 60 * 1000) },
    })
    const tail = (where) => (chunk) => {
      const text = String(chunk).slice(0, 2000)
      void record('[' + where + '] ' + text.replace(/\r?\n$/, '') + '\n')
    }
    child.stdout.on('data', tail('out'))
    child.stderr.on('data', tail('err'))
    child.on('error', (e) => { void record('spawn failed: ' + (e && e.message) + '\n') })
    child.on('exit', (code) => { child = null; void record('daemon exited ' + code + '\n') })
    child.unref()
    const attempts = Math.max(2, Math.round(budgetMs / 1000))
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 250 : 1000))
      let h = null
      try { h = await health() } catch { /* daemon not listening yet */ }
      if (h && h.ok && h.ctx) { log('daemon up (pid ' + h.pid + ')'); return h }
      // A daemon that names a reason it cannot start will not start. Reporting it
      // now is what turns "did not become ready within 45000ms" into the sentence
      // that says which lookup failed and how to satisfy it.
      if (h && h.terminal) {
        await record('daemon cannot start: ' + h.reason + '\n')
        throw new Error(h.reason)
      }
    }
    throw new Error('the pi daemon did not become ready within ' + budgetMs + 'ms; check ' + LOG)
  })().finally(() => { starting = null })
  return starting
}

/**
 * Materialize a pi package for the proxy: fetch the source and install its own
 * dependencies. Nothing is mirrored with stubs and nothing is transpiled; pi
 * loads the package as pi would, from this directory.
 * @param {string} spec
 * @param {{log?,refresh?:boolean}} [options]
 */
export async function materialize (spec, options) {
  const log = (options && options.log) || (() => {})
  const resolved = await resolveSource(spec, { log, refresh: !!(options && options.refresh) })
  const info = await classify(resolved.dir)
  if (!info.pi && !info.dsh) throw new Error('no plugin manifest found in ' + spec)

  // Published dependencies must exist before pi loads the package: pi resolves
  // bare specifiers from the package's own node_modules, so a missing one is a
  // load-time crash, not something a stub can paper over.
  const deps = await installDependencies(resolved.dir, log)
  const entries = await piEntries(resolved.dir, info.pkg)
  const result = {
    root: resolved.dir,
    info,
    from: resolved.from,
    dependencies: deps,
    // Skills are SKILL.md directories: portable as data, so a host can mount
    // them without running any of the package's code.
    skills: entries.skills,
    extensions: entries.extensions,
  }
  if (deps.status === 'failed') {
    throw new Error('cannot install the package\u2019s ' + deps.count + ' dependencies (' + deps.reason + '); the tools would fail on first call')
  }
  return result
}

/**
 * Load a materialized package into the running pi process.
 *
 * Takes the materialize() result, not a caller-held path: dependencies are
 * installed into the cache copy, and loading the original source directory
 * instead would crash on the first bare import. Accepting the object makes that
 * mistake impossible to make.
 * @param {{root:string, info?:any, dependencies?:any}} materialized
 * @param {{log?:(m:string)=>void}} [options]
 */
export async function loadIntoPi (materialized, options) {
  const log = (options && options.log) || (() => {})
  const waitMs = options && options.waitMs
  const root = typeof materialized === 'string' ? materialized : materialized && materialized.root
  if (!root) throw new Error('loadIntoPi needs the result of materialize()')
  if (typeof materialized === 'object' && materialized.dependencies && materialized.dependencies.status === 'failed') {
    throw new Error('refusing to load: dependencies failed (' + materialized.dependencies.reason + ')')
  }
  await ensureDaemon({ log, waitMs })
  const reply = await request('POST', '/load', { root }, 60000)
  /*
   * A failed load must not look like a successful load that found nothing.
   *
   * The daemon reports a refusal as { ok: false, error } - singular - while the
   * plural errors array holds per-file problems from a load that did succeed.
   * Callers only read the plural one, so every refusal came back as "zero tools"
   * and moved on: two published packages were written off as having nothing to
   * contribute while pi had actually refused them outright.
   */
  if (reply && reply.ok === false && reply.error) throw new Error('pi could not load the package: ' + reply.error)
  return reply
}

/**
 * Install a pi package through the proxy: materialize, load, report.
 * @param {string} spec
 * @param {{log?,refresh?:boolean}} [options]
 */
export async function installThroughProxy (spec, options) {
  const log = (options && options.log) || (() => {})
  const materialized = await materialize(spec, { log, refresh: !!(options && options.refresh) })
  const loaded = await loadIntoPi(materialized, { log })
  return { materialized, loaded }
}

/** List tools the bridge loaded inside pi. */
export async function listTools () {
  await ensureDaemon()
  return request('GET', '/tools', null, 20000)
}

/** Call one loaded tool inside pi and return its native result. */
export async function callTool (name, args, ms = 120000) {
  await ensureDaemon()
  return request('POST', '/call', { name, args }, ms)
}

export function daemonInfo () {
  return { port: PORT, log: LOG, runner: RUNNER, runnerExists: existsSync(RUNNER) }
}
