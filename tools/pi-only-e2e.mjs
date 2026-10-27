/**
 * The other direction, on a machine that has no DSH: install a DSH bundle from pi.
 *
 * This is the live half of the requirement that no offline suite can settle -
 * whether a pi, given nothing but itself, can end up running a DSH bundle
 * natively instead of replaying its registrations onto stand-ins. Everything
 * asserted here happens in a real process pair: a real pi extension calling
 * dsh_install, which starts a real DSH profile and forwards to it.
 *
 * Two things make it runnable repeatedly. The vendor directory it reads is the
 * one a provisioning run would produce (DSH2PI_VENDOR points at it), so only the
 * first run is expensive; and the port is chosen per run, so a leftover host from
 * an earlier attempt is never mistaken for this one's.
 *
 * Run: node tools/dsh-only-e2e.mjs <fixture-bundle-dir>
 *   DSH2PI_HOME   scratch home to run under (default: a temp dir)
 *   DSH2PI_VENDOR an existing vendor dir holding @deepseek-ai/dsh
 */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// Absolute: a relative path is read as an npm package name by the far side, which
// then tries to fetch it from the registry instead of loading the directory.
const FIXTURE = path.resolve(process.argv[2] || path.join(ROOT, 'scripts', 'fixtures', 'dsh-introspect'))
const HOME = process.env.DSH2PI_HOME || await mkdtemp(path.join(os.tmpdir(), 'dsh2pi-pi-only-'))
const VENDOR = process.env.DSH2PI_VENDOR || ''
const PORT = 48000 + Math.floor(Math.random() * 400)

let failures = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label)
  else { failures++; console.log('  FAIL ' + label + (detail ? ' :: ' + detail : '')) }
}

process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DSH_PI_BRIDGE_DSH_ENDPOINT = '127.0.0.1:' + PORT
process.env.DSH_PI_BRIDGE_HOME = path.join(HOME, 'cache')
process.env.PATH = [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter)
delete process.env.DSH_PI_BRIDGE_DSH
delete process.env.DSH_PI_BRIDGE_NO_PROVISION

if (VENDOR) {
  const target = path.join(HOME, '.dsh-pi-bridge', 'vendor')
  await mkdir(path.dirname(target), { recursive: true })
  await symlink(VENDOR, target, process.platform === 'win32' ? 'junction' : 'dir')
}

const { ensureDshHost, stopDshHost, dshHomeDir, PROFILE } = await import('../src/dsh-supervisor.js')
const { dshHostStatus } = await import('../src/dsh-host-client.js')

// No DSH may be reachable before the run, or this proves nothing.
let before = null
try { before = await dshHostStatus({ endpoint: { host: '127.0.0.1', port: PORT } }) } catch { /* expected */ }
check('nothing is serving on the port before the run', !before, JSON.stringify(before))

// The requirement, exercised as a user meets it: the install is the first thing
// that happens, so supplying the host is the install's own job.
console.log('installing a DSH bundle through the pi extension, with no host running')
const pi = { tools: [], commands: [], events: [] }
pi.registerTool = (t) => pi.tools.push(t)
pi.registerCommand = (n, o) => pi.commands.push({ name: n, ...o })
pi.on = (n, h) => { pi.events.push({ n, h }); return () => {} }
pi.ui = { notify: () => {} }

const factory = (await import(pathToFileURL(path.join(ROOT, 'extensions', 'index.js')).href)).default
await factory(pi)
const install = pi.tools.find((t) => t.name === 'dsh_install')
check('the pi extension registered dsh_install', !!install, JSON.stringify(pi.tools.map((t) => t.name)))

const out = await install.execute('t1', { source: FIXTURE }, undefined, undefined, { ui: { notify: () => {} } })
const text = (out && out.content && out.content[0] && out.content[0].text) || ''
check('the install did not fall back to replay', !/mode: registrations replayed/.test(text), text.slice(0, 240))
check('it supplied a host instead of degrading', /via a DSH this bridge started/.test(text), text.slice(0, 200))
check('a capability arrived', /tools: (?!none)\S/.test(text), text.slice(0, 240))
console.log(text.split('\n').map((l) => '  | ' + l).join('\n'))

const started = { port: PORT }
check('the supplied host answers where it was asked to', !!((await dshHostStatus({ endpoint: { host: '127.0.0.1', port: PORT } })).serve))

const profilePkg = JSON.parse(await readFile(path.join(dshHomeDir(), 'profiles', PROFILE, 'package.json'), 'utf8'))
check('the profile carries the bridge as a bundle', profilePkg.dsh.profile.bundles.includes('dsh-pi-bridge'), JSON.stringify(profilePkg.dsh.profile.bundles))

// And a call must reach DSH, not a stand-in. The tool is taken from the report
// this bridge just printed rather than from a hardcoded exclusion list: the list
// went stale the moment a third bridge tool was added, and the suite then called
// that tool and read its failure as a forwarding failure.
const reportedNames = (/tools: ([^\n]+)/.exec(text)?.[1] || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && s !== 'none')
const forwarded = pi.tools.filter((t) => reportedNames.includes(t.name))
check('the report names a tool that is actually registered', forwarded.length > 0, JSON.stringify({ reportedNames, registered: pi.tools.map((t) => t.name) }))
if (forwarded.length) {
  const res = await forwarded[0].execute('t2', {}, undefined, undefined, { ui: { notify: () => {} } })
  const body = (res && res.content && res.content[0] && res.content[0].text) || ''
  check('a forwarded tool answers through DSH', body.length > 0 && !/failed/.test(body), body.slice(0, 160))
  check('the answer is marked as coming from DSH', !!(res && res.details && res.details.viaDsh), JSON.stringify(res && res.details).slice(0, 120))

  // Faithfulness, not reachability: the call has to enter DSH's tool registry so
  // the plugin's own pre/post policies and content finalisation run. A raw
  // `def.execute` answers too, and would pass every check above.
  const health = await dshHostStatus({ endpoint: { host: '127.0.0.1', port: PORT } })
  check('calls from pi go through the DSH tools registry', !!health && health.callPath === 'registry', JSON.stringify(health).slice(0, 180))
}

// Reuse: a second call must not start a second host.
const again = await ensureDshHost({ log: () => {}, waitMs: 10000 })
check('a second ask reuses the running host', again.reused === true, JSON.stringify(again).slice(0, 160))

// Leave nothing behind.
await stopDshHost({ env: process.env })
await new Promise((r) => setTimeout(r, 1500))
let after = null
try { after = await dshHostStatus({ endpoint: { host: '127.0.0.1', port: PORT } }) } catch { /* expected */ }
check('the host stopped when asked', !after, JSON.stringify(after))

console.log('')
console.log(failures ? failures + ' CHECK(S) FAILED' : 'pi-only direction passed: a DSH was supplied, and a bundle ran natively inside it')
if (process.env.DSH2PI_KEEP !== '1') await rm(HOME, { recursive: true, force: true })
else { await writeFile(path.join(HOME, 'ran.txt'), 'kept\n'); console.log('scratch kept at ' + HOME) }
process.exit(failures ? 1 : 0)
