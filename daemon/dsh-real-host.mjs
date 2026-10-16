/**
 * Pi side against a real DSH session.
 *
 * dsh-host-e2e checks pi's forwarding logic against a stand-in server that
 * answers exactly like the DSH half; the live boot checked DSH against a raw
 * curl. Neither alone proves the composed path. Here the client code pi actually
 * uses - dshHostLoad / dshHostCall, plus the extension's own registration of a
 * forwarding tool - is run against a DSH process that the operator started.
 *
 * Run while DSH is booting: node daemon/dsh-real-host.mjs [fixture-path]
 */
import { dshHostStatus, dshHostLoad, dshHostCall, dshParamsToSchema } from '../src/dsh-host-client.js'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

// fileURLToPath decodes percent-escapes; URL.pathname does not, so a non-ASCII
// working directory turned into a path that does not exist ("dsh%E6%8F%92...").
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FIXTURE = process.argv[2] || path.join(ROOT, '.hostload-fixture')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (l, ok, d) => { if (ok) console.log('  ok   ' + l); else { failures++; console.log('  FAIL ' + l + (d ? ' :: ' + String(d).slice(0, 200) : '')) } }

// Wait for the DSH session to start serving.
let health = null
for (let i = 0; i < 60; i++) {
  try { health = await dshHostStatus(); if (health && health.ok && health.serve) break } catch { /* not up */ }
  await sleep(2000)
}
check('a live DSH session is serving plugins', !!(health && health.ok && health.serve), JSON.stringify(health).slice(0, 160))
if (!(health && health.serve)) { console.log('\nDSH REAL-HOST SKIPPED (no live session)'); process.exit(0) }
console.log('  DSH pid=' + health.pid)

const loaded = await dshHostLoad(FIXTURE.replace(/\\/g, '/'))
check('the real DSH loaded the bundle', !!loaded.ok && Array.isArray(loaded.tools) && loaded.tools.length > 0, JSON.stringify(loaded).slice(0, 220))
const tool = (loaded.tools || [])[0]
if (!tool) { console.log('no tool arrived'); process.exit(1) }

check('DSH handed back a parameter shape we can convert', !!dshParamsToSchema(tool.parameters).properties?.text, JSON.stringify(tool.parameters))

const res = await dshHostCall(tool.name, { text: 'via-pi-side' })
check('the real DSH executed the tool for us', !!res.ok && String(res.result?.result || '').includes('via-pi-side'), JSON.stringify(res).slice(0, 220))

// Now the same through pi's extension: register the forwarding tool and call it.
const mod = await import(pathToFileURL(path.join(ROOT, 'extensions', 'index.js')).href)
const tools = []
const pi = { registerTool: (t) => tools.push(t), registerCommand: () => {}, on: () => () => {}, ui: { notify: () => {} } }
await mod.default(pi)
const install = tools.find((t) => t.name === 'dsh_install')
const out = await install.execute('id', { source: FIXTURE.replace(/\\/g, '/') }, undefined, undefined, { ui: { notify: () => {} } })
const text = String(out.content[0].text)
check('pi chose the live-DSH path over translating', /via live DSH/.test(text), text.slice(0, 200))
const fwd = tools.find((t) => t.name.endsWith('_' + tool.name))
check('pi registered a forwarding tool', !!fwd, tools.map((t) => t.name).join(','))
if (fwd) {
  const r2 = await fwd.execute('id2', { text: 'end-to-end' })
  const t2 = String(r2.content[0].text)
  check('calling it ran inside the real DSH', t2.includes('end-to-end') && !/failed/.test(t2.slice(0, 30)), t2.slice(0, 200))
}

console.log('')
console.log(failures ? 'DSH REAL-HOST FAILED (' + failures + ')' : 'DSH REAL-HOST PASSED')
process.exitCode = failures ? 1 : 0
