/**
 * A machine with only DSH: install and run a pi package.
 *
 * Companion to tools/pi-only-e2e.mjs, which proves the mirror case. Both start
 * from "the other host is not installed anywhere" and let the bridge supply it,
 * because that - not a graceful failure - is the requirement.
 *
 * Asserted here, in order: no pi is reachable, a pinned pi is installed into the
 * bridge's own vendor directory, the daemon it supervises captures an extension
 * context, a real pi package is installed through the same proxy a DSH user's
 * pi_install uses, and calling that package's tool returns what the package
 * computed. The last two are what separate "a runtime exists" from "a pi plugin
 * works", and only the second is worth shipping.
 *
 * The environment is built rather than borrowed: PATH keeps node's own directory
 * (so npm is reachable) and nothing else that could hold a pi, and HOME points at
 * a scratch directory, so a pi installed on the real machine cannot make this pass.
 *
 * Run: node tools/dsh-only-e2e.mjs
 *   DSH2PI_HOME   scratch home (default: a temp dir, removed afterwards)
 *   DSH2PI_KEEP=1 keep it
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HOME = process.env.DSH2PI_HOME || await mkdtemp(path.join(os.tmpdir(), 'dsh2pi-dsh-only-'))
const PORT = 48600 + Math.floor(Math.random() * 300)

let failures = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label)
  else { failures++; console.log('  FAIL ' + label + (detail ? ' :: ' + String(detail).slice(0, 220) : '')) }
}

// Only node's own directory: npm is reachable, pi is not.
const nodeDir = path.dirname(execPath)
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.PATH = nodeDir
process.env.Path = nodeDir
process.env.DSH_PI_BRIDGE_HOME = path.join(HOME, 'cache')
process.env.DSH_PI_BRIDGE_DAEMON_PORT = String(PORT)
delete process.env.DSH_PI_BRIDGE_PI
delete process.env.PI_MODULE_DIR
delete process.env.DSH_PI_BRIDGE_NO_PROVISION

const { resolvePi } = await import('../src/pi-launch.js')
const { ensureDaemon, stopDaemon, installThroughProxy, callTool, listTools } = await import('../src/proxy.js')
const { vendorRoot } = await import('../src/provision.js')

const before = resolvePi({ env: process.env })
check('no pi is reachable before the run', before.ok === false, JSON.stringify(before).slice(0, 160))

console.log('supplying pi on a machine that has none')
const started = Date.now()
const health = await ensureDaemon({ waitMs: 240000, log: (m) => console.log('  .. ' + m) })
const elapsed = Date.now() - started
check('a pi daemon came up', !!(health && health.ok), JSON.stringify(health).slice(0, 160))
check('it captured an extension context', !!(health && health.ctx))
check('a pi runtime was provisioned, not borrowed', resolvePi({ env: process.env }).moduleDir.startsWith(vendorRoot(process.env)), resolvePi({ env: process.env }).moduleDir)
console.log('  .. ' + Math.round(elapsed / 1000) + 's cold, including the download')

const again = await ensureDaemon({ waitMs: 20000 })
check('a second ask reuses the daemon', again && again.pid === health.pid, JSON.stringify(again && again.pid))

// The part that matters: a pi package, not just a pi runtime.
console.log('installing a pi package through the path pi_install takes')
const installed = await installThroughProxy(path.join(ROOT, 'scripts', 'fixtures', 'pi-demo'), { log: (m) => console.log('  .. ' + m) })
// Read the registry the daemon actually holds rather than the load reply's shape:
// what matters is that pi can later be asked for this tool by name.
const listed = await listTools()
const names = (listed.tools || []).map((t) => t.name)
check('the package registered its tool in pi', names.includes('demo_echo'), JSON.stringify(names).slice(0, 180))
const echoed = await callTool('demo_echo', { text: 'from-a-dsh-only-machine' })
// The fixture uppercases its reply, so compare case-insensitively: the claim is
// that the text travelled into pi and came back, not how it was cased.
check('the tool ran in pi and returned what it computed', JSON.stringify(echoed || {}).toLowerCase().includes('from-a-dsh-only-machine'), JSON.stringify(echoed).slice(0, 240))
check('the load did not report an error', !(installed && installed.loaded && installed.loaded.ok === false), JSON.stringify(installed && installed.loaded).slice(0, 200))

await stopDaemon(8000)
console.log('')
console.log(failures ? failures + ' CHECK(S) FAILED' : 'dsh-only direction passed: pi was supplied, a pi package loaded, and its tool answered')
if (process.env.DSH2PI_KEEP !== '1') {
  // Windows refuses to remove a directory a just-stopped daemon still holds; the
  // verdict is already decided, so a leftover scratch dir is a note, not an error.
  for (let i = 0; i < 5; i++) {
    try { await rm(HOME, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
} else console.log('scratch kept at ' + HOME)
process.exit(failures ? 1 : 0)
