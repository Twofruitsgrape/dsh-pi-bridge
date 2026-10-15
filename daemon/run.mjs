/**
 * The pi side of the bridge: a supervised `pi --mode rpc` process whose loaded
 * extensions are real pi packages. A DSH session talks to it over loopback HTTP;
 * the packages themselves never leave pi.
 *
 * Kept deliberately thin:
 *   - speak pi's JSONL framing (split on LF only; readline would also break on
 *     U+2028/2029, which are legal inside JSON strings)
 *   - answer extension_ui_request records so a dialog cannot hang a caller
 *   - forward /tools and /call to the bootstrap listener inside pi
 *   - exit on idle or signal so no orphaned pi process is left behind
 *
 * Usage: node daemon/run.mjs --packages '<json array of package roots>' [--port N]
 */
import { spawn } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function arg (name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const PORT = Number(arg('port', process.env.DSH_PI_BRIDGE_DAEMON_PORT || 43117))
const UPSTREAM = Number(process.env.DSH_PI_BRIDGE_BOOTSTRAP_PORT || PORT + 1)
let packages = []
try { packages = JSON.parse(arg('packages', '[]')) } catch { packages = [] }
const JOURNAL = arg('journal', path.join(ROOT, '.tmp', 'daemon', 'journal.txt'))
const AUTO_DIALOG = process.env.DSH_PI_BRIDGE_AUTO_DIALOG !== '0'

/**
 * Where pi's own package lives: jiti and the host-package aliases resolve from
 * here, so a bridged package imports pi's genuine modules instead of stubs.
 */
function findPiModuleDir () {
  if (process.env.PI_MODULE_DIR) return process.env.PI_MODULE_DIR
  const roots = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean)
  for (const r of roots) {
    const dir = path.join(r, '@earendil-works', 'pi-coding-agent')
    try { if (existsSync(path.join(dir, 'package.json'))) return dir } catch { /* next */ }
  }
  return ''
}

await mkdir(path.dirname(JOURNAL), { recursive: true })
const step = (m) => appendFile(JOURNAL, '[' + new Date().toISOString().slice(11, 19) + '] ' + m + '\n', 'utf8')

// --no-extensions keeps loading under the bridge's control: pi's own discovery
// would load the same package a second time, and a duplicate registerTool is a
// real conflict rather than something the bridge can paper over.
const child = spawn('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--extension', path.join(HERE, 'bootstrap.js')], {
  cwd: ROOT,
  shell: process.platform === 'win32',
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_PI_BRIDGE_PACKAGES: JSON.stringify(packages),
    DSH_PI_BRIDGE_PORT: String(UPSTREAM),
    PI_MODULE_DIR: findPiModuleDir(),
  },
})
void step('spawn pi --mode rpc pid=' + child.pid + ' packages=' + JSON.stringify(packages))

const waiting = new Map()
const dialogs = []

function rpcCommand (obj, ms = 30000) {
  const id = 'd' + Math.random().toString(36).slice(2, 9)
  return new Promise((res) => {
    const timer = setTimeout(() => { waiting.delete(id); res({ timeout: true }) }, ms)
    waiting.set(id, (rec) => { clearTimeout(timer); res(rec) })
    try { child.stdin.write(JSON.stringify({ id, ...obj }) + '\n') }
    catch (e) { clearTimeout(timer); res({ error: String(e.message) }) }
  })
}

let stdoutBuf = ''
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString('utf8')
  let nl
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
    stdoutBuf = stdoutBuf.slice(nl + 1)
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { void step('non-json stdout ' + line.slice(0, 120)); continue }
    if (rec.type === 'response') {
      const cb = rec.id && waiting.get(rec.id)
      if (cb) { waiting.delete(rec.id); cb(rec) }
      continue
    }
    if (rec.type === 'extension_ui_request') {
      // A bridged tool that wants a decision cannot block a DSH chat: notify-style
      // records are logged, dialog records get a deterministic answer that is also
      // surfaced on the call result so the caller sees the tool asked for input.
      const isDialog = ['select', 'confirm', 'input', 'editor'].includes(rec.method)
      void step('ui_request ' + rec.method + (isDialog ? ' (dialog)' : ''))
      if (isDialog) {
        dialogs.push({ method: rec.method, title: rec.title, at: Date.now() })
        if (AUTO_DIALOG) {
          const data = rec.method === 'select'
            ? (Array.isArray(rec.options) ? rec.options[0] : undefined)
            : rec.method === 'confirm' ? true : rec.method === 'input' || rec.method === 'editor' ? '' : undefined
          try { child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: rec.id, data }) + '\n') } catch { /* closing */ }
        }
      }
      continue
    }
    if (rec.type === 'tool_execution_start' || rec.type === 'tool_execution_end') {
      void step('event ' + rec.type + ' ' + (rec.toolName || ''))
    }
  }
})
let stderrTail = ''
child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000) })
child.on('error', (e) => void step('spawn error ' + e.message))
child.on('close', (c) => void step('pi exited code=' + c + ' stderr=' + stderrTail.replace(/\s+/g, ' ').slice(-200)))

async function forward (reqPath, body) {
  const res = await fetch('http://127.0.0.1:' + UPSTREAM + reqPath, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json')
    const p = (req.url || '/').split('?')[0]
    try {
      if (p === '/shutdown') {
        res.end(JSON.stringify({ ok: true, stopping: true }))
        setTimeout(() => shutdown('requested'), 200)
        return
      }
      if (p === '/daemon') {
        return res.end(JSON.stringify({ pid: child.pid, alive: child.exitCode === null, packages, upstream: UPSTREAM, dialogs: dialogs.length }))
      }
      const body = raw ? JSON.parse(raw) : null
      const out = await forward(p, body)
      if (p === '/call' && out && out.ok) out.dialogs = dialogs.slice(-3)
      res.end(JSON.stringify(out))
    } catch (e) {
      res.end(JSON.stringify({ ok: false, error: 'daemon: ' + String(e && e.message).slice(0, 200) }))
    }
  })
})
server.listen(PORT, '127.0.0.1', () => void step('daemon listening 127.0.0.1:' + PORT))

async function ensureBootstrap () {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const h = await forward('/health', null)
      if (h && h.ok) { await step('bootstrap up; tools=' + h.tools + ' ctx=' + h.ctx); return h }
    } catch { await step('waiting for bootstrap (attempt ' + i + ')') }
  }
  return null
}

let lastActivity = Date.now()
const emit = server.emit.bind(server)
server.emit = (...a) => { lastActivity = Date.now(); return emit(...a) }
const IDLE_MS = Number(process.env.DSH_PI_BRIDGE_IDLE_MS || 900000)
setInterval(() => { if (Date.now() - lastActivity > IDLE_MS) void shutdown('idle timeout') }, 30000).unref()

function shutdown (why) {
  void step('shutdown: ' + why)
  try { child.stdin.end() } catch { /* gone */ }
  try { child.kill() } catch { /* gone */ }
  server.close()
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

void (async () => {
  // pi starts a session only when there is work, and the bootstrap captures its
  // extension context with it. get_state opens the channel; --no-session keeps
  // the run off disk.
  const st = await rpcCommand({ type: 'get_state' }, 30000)
  await step('get_state ' + (st.timeout ? 'TIMEOUT' : 'success=' + st.success))
  const h = await ensureBootstrap()
  if (!h) await step('bootstrap never came up')
})()
