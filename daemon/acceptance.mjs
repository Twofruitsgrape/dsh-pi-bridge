/**
 * Proxy acceptance: prove a pi package really runs inside pi and answers the
 * bridge endpoint, with no translation anywhere in the path.
 *
 * This is the test the old replay architecture could never pass, because it
 * asserts the thing that actually matters to a user: the tool returns a real
 * result computed by the package's own code, using pi's real model registry,
 * credentials and dependencies.
 *
 * Offline by default (a fixture package with no network), and it skips cleanly
 * where the pi CLI is absent so the published test suite still runs.
 *
 * Run: node daemon/acceptance.mjs [--live] (—live also calls a real installed package)
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PORT = Number(process.env.DSH_PI_BRIDGE_TEST_PORT || 43199)
const UPSTREAM = PORT + 1
const LIVE = process.argv.includes('--live')
const TMP = path.join(ROOT, '.tmp', 'acceptance')
await mkdir(TMP, { recursive: true })
const JOURNAL = path.join(TMP, 'journal.txt')
await rm(JOURNAL, { force: true })
const note = (m) => appendFile(JOURNAL, m + '\n', 'utf8')

let failures = 0
function check (label, cond, detail) {
  if (cond) console.log('  ok   ' + label)
  else { failures++; console.log('  FAIL ' + label + (detail ? ' :: ' + String(detail).slice(0, 220) : '')) }
}

function findPi () {
  const dirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '.bin'),
    '/usr/local/bin', '/usr/bin',
  ]
  for (const d of dirs) {
    for (const n of ['pi.cmd', 'pi']) {
      const p = path.join(d, n)
      try { if (existsSync(p)) return true } catch { /* next */ }
    }
  }
  return false
}

if (!findPi()) { console.log('SKIP: pi CLI not installed on this machine'); process.exit(0) }

const fixture = path.join(ROOT, 'scripts', 'fixtures', 'pi-demo').replace(/\\/g, '/')
const pkgs = [fixture]
if (LIVE) {
  const real = path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-web-access')
  if (existsSync(path.join(real, 'package.json'))) pkgs.push(real.replace(/\\/g, '/'))
  else console.log('  (live mode requested but pi-web-access is not installed)')
}

const child = spawn('node', [path.join(HERE, 'run.mjs'), '--packages', JSON.stringify(pkgs), '--port', String(PORT), '--journal', JOURNAL], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DSH_PI_BRIDGE_IDLE_MS: '120000' },
})
let stderr = ''
child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000) })

const keep = setInterval(() => {}, 1000)
/**
 * A plain HTTP request with no connection reuse. undici's keep-alive sockets are
 * still open when the test exits, which trips a libuv assertion on Windows and
 * turns a passing run into exit 127; agent:false removes that class of noise.
 */
function request (method, p, body, ms) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, agent: false, timeout: ms, headers: { 'content-type': 'application/json' } }, (r) => {
      let raw = ''
      r.on('data', (c) => { raw += c })
      r.on('end', () => { try { res(JSON.parse(raw)) } catch (e) { rej(new Error('bad json from ' + p + ': ' + raw.slice(0, 120))) } })
    })
    req.on('timeout', () => { req.destroy(new Error('timeout ' + p)) })
    req.on('error', rej)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}
async function get (p, ms = 20000) {
  return request('GET', p, null, ms)
}
async function call (name, args, ms = 90000) {
  return request('POST', '/call', { name, args }, ms)
}

try {
  // Wait for the bootstrap inside pi to report a captured extension context.
  let health = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try { health = await get('/health'); if (health && health.ok && health.ctx) break } catch { /* not up */ }
  }
  check('daemon + pi RPC child + bootstrap came up', !!(health && health.ok && health.ctx), JSON.stringify(health))

  const tools = await get('/tools')
  const names = (tools.tools || []).map(t => t.name)
  check('bridge loaded the fixture package', names.includes('demo_echo'), names.join(','))
  check('tool is live inside real pi, not a stub', (tools.activeInPi || []).includes('demo_echo'), JSON.stringify(tools.activeInPi))
  check('parameter schema crossed intact', !!(tools.tools || []).find(t => t.name === 'demo_echo' && t.parameters && t.parameters.properties && t.parameters.properties.text), JSON.stringify((tools.tools || []).find(t => t.name === 'demo_echo')))

  const out = await call('demo_echo', { text: 'inside pi' })
  const text = out && out.result && out.result.content && out.result.content[0] && out.result.content[0].text
  check('tool executed and returned the package result', !!out.ok && text === 'INSIDE PI', JSON.stringify(out))
  check('unknown tool is refused, not guessed', !!(await call('definitely_not_a_tool', {})).ok === false)

  // Dynamic load is what pi_install needs: a new package joins a session that
  // is already running, without restarting pi or the daemon.
  {
    const fresh = path.join(TMP, 'late-package')
    await mkdir(path.join(fresh, 'extensions'), { recursive: true })
    await writeFile(path.join(fresh, 'package.json'), JSON.stringify({
      name: 'late-package', version: '1.0.0', type: 'module', keywords: ['pi-package'],
      pi: { extensions: ['./extensions'] },
    }, null, 2), 'utf8')
    await writeFile(path.join(fresh, 'extensions', 'index.js'),
      'export default function (pi) {\n  pi.registerTool({\n    name: "late_tool",\n    label: "Late",\n    description: "Registered after startup.",\n    parameters: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },\n    async execute (_id, p) { return { content: [{ type: "text", text: "late:" + p.v }] } },\n  })\n}\n', 'utf8')
    const loaded = await request('POST', '/load', { root: fresh.replace(/\\/g, '/') }, 30000)
    check('a new package loads into the running pi', !!(loaded.ok && (loaded.added || []).some(t => t.name === 'late_tool')), JSON.stringify(loaded).slice(0, 240))
    const late = await call('late_tool', { v: 'x' }, 20000)
    const lt = late && late.result && late.result.content && String(late.result.content[0].text || '')
    check('dynamically loaded tool executes', !!late.ok && lt === 'late:x', JSON.stringify(late).slice(0, 200))
  }

  if (LIVE && names.includes('web_search')) {
    const live = await call('web_search', { query: 'DeepSeek V4' }, 120000)
    const lt = live && live.result && live.result.content && String(live.result.content[0].text || '')
    check('real installed package answers over the bridge', !!live.ok && lt.length > 80, JSON.stringify(live).slice(0, 200))
  }
} catch (e) {
  check('acceptance run completed', false, (e && e.message) + ' stderr=' + stderr.slice(-200))
} finally {
  clearInterval(keep)
  // Ask the daemon to tear itself down (it closes pi), then wait for the exit
  // instead of killing: a hard kill mid-shutdown is what produced the noisy
  // Windows teardown assertion.
  try { await request('GET', '/shutdown', null, 5000) } catch { /* already down */ }
  const closed = await Promise.race([
    new Promise((res) => child.once('close', (c) => res('close:' + c))),
    new Promise((res) => setTimeout(() => res('timeout'), 8000)),
  ])
  if (String(closed) === 'timeout') { try { child.kill() } catch { /* gone */ } }
  await note('test done failures=' + failures + ' teardown=' + closed)
}
process.exitCode = failures ? 1 : 0

console.log('')
if (failures) console.log('DAEMON ACCEPTANCE FAILED (' + failures + ')')
else console.log('DAEMON ACCEPTANCE PASSED')
