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
import { classify, piEntries } from './manifest.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RUNNER = path.join(ROOT, 'daemon', 'run.mjs')
const PORT = Number(process.env.DSH_PI_BRIDGE_DAEMON_PORT || 43117)
const LOG = path.join(CACHE_ROOT, 'daemon.log')

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
export async function ensureDaemon (options) {
  const log = (options && options.log) || (() => {})
  try {
    const h = await health()
    if (h && h.ok) return h
  } catch { /* not running */ }
  if (starting) return starting
  starting = (async () => {
    await record('\n[' + new Date().toISOString() + '] starting daemon\n')
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
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const h = await health()
        if (h && h.ok && h.ctx) { log('daemon up (pid ' + h.pid + ')'); return h }
      } catch { /* keep waiting */ }
    }
    throw new Error('the pi daemon did not become ready; check ' + LOG)
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
  const root = typeof materialized === 'string' ? materialized : materialized && materialized.root
  if (!root) throw new Error('loadIntoPi needs the result of materialize()')
  if (typeof materialized === 'object' && materialized.dependencies && materialized.dependencies.status === 'failed') {
    throw new Error('refusing to load: dependencies failed (' + materialized.dependencies.reason + ')')
  }
  await ensureDaemon({ log })
  return request('POST', '/load', { root }, 60000)
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
