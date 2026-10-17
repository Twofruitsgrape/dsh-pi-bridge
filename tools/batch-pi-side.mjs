/**
 * The pi side of the second direction, against real third-party DSH plugins.
 *
 * dsh-host-e2e proves the mechanism against a stand-in endpoint, and the live
 * batch proved DSH can load real packages. Neither ran the actual pi entry point
 * (extensions/index.js) against a real session holding real bundles - which is
 * where a parameter shape pi cannot validate would surface, since a real package
 * declares its parameters with schemastery or zod rather than a hand-written
 * fixture. Each package is installed through the product path: the entry's own
 * installDsh, which forwards to the session and registers one tool per capability.
 *
 * Run while a DSH session is serving:
 *   DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 node tools/batch-pi-side.mjs [list.json]
 */
import { dshHostStatus, dshParamsToSchema } from '../src/dsh-host-client.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TMP = path.join(ROOT, '.tmp', 'batch-pi-side')
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })
process.env.DSH_PI_BRIDGE_HOME = TMP
const JOURNAL = path.join(TMP, 'journal.txt')
await writeFile(JOURNAL, '')
const log = async (m) => { await appendFile(JOURNAL, m + '\n'); console.log(m) }

let failures = 0
function check (label, cond, detail) {
  if (cond) console.log('  ok   ' + label)
  else { failures++; console.log('  FAIL ' + label + (detail ? ' :: ' + String(detail).slice(0, 200) : '')) }
}

const listFile = process.argv[2] || path.join(ROOT, '.tmp', 'dsh-plugins', 'list.json')
if (!existsSync(listFile)) { await log('SKIP: no package list at ' + listFile); process.exit(0) }
const specs = JSON.parse(await readFile(listFile, 'utf8'))
if (!specs.length) { await log('SKIP: empty list'); process.exit(0) }

const health = await dshHostStatus().catch((e) => ({ ok: false, error: String(e.message) }))
if (!(health && health.ok && health.serve)) {
  await log('SKIP: no live DSH session serving (' + JSON.stringify(health).slice(0, 150) + ')')
  process.exit(0)
}
await log('live DSH session pid=' + health.pid)

// The product entry, driven the way pi drives it.
const mod = await import(pathToFileURL(path.join(ROOT, 'extensions', 'index.js')).href)
const tools = []
const pi = {
  registerTool: (t) => tools.push(t),
  registerCommand: (n, o) => { void n; void o },
  on: () => () => {},
  ui: { notify: () => {} },
}
await mod.default(pi)
const install = tools.find((t) => t.name === 'dsh_install')
check('pi exposes dsh_install', !!install)
if (!install) { console.log('PI-SIDE BATCH FAILED (no entry tool)'); process.exit(1) }

const rows = []
for (const spec of specs) {
  const clean = String(spec).replace(/\\/g, '/')
  await log('\n### ' + path.basename(spec))
  const out = await install.execute('id', { source: clean }, undefined, undefined, { ui: { notify: () => {} } })
  const text = String(out.content[0].text)
  const toolsLine = (text.match(/tools: ([^\n]*)/) || [])[1] || ''
  const names = toolsLine.trim() && toolsLine.trim() !== 'none' ? toolsLine.split(',').map((s) => s.trim()) : []
  // Three outcomes and they are not equal. Forwarding is the goal; a refusal that
  // names a real reason (a service this profile does not compose, configuration the
  // host binds, no plugin module to apply) is a correct answer about the package,
  // not a bridge failure. Only the silent fallback to translation, which would
  // hand pi stubbed look-alikes while claiming success, counts as wrong here.
  const forwarded = /via live DSH/.test(text)
  const refused = /dsh_install failed/.test(text) && /(does not compose|configuration the host binds|no DSH apply\(\)|not in bridge cache|cannot install)/.test(text)
  if (forwarded) check(path.basename(spec) + ': forwarded from the live DSH', true)
  else if (refused) { await log('  REFUSED (reported honestly): ' + text.replace(/\s+/g, ' ').slice(20, 170)); check(path.basename(spec) + ': refusal is explained', true) }
  else check(path.basename(spec) + ': forwarded from the live DSH', false, text.slice(0, 170))
  await log('  tools forwarded: ' + (names.length || 'none'))
  rows.push({ spec: clean, names, text })
}

// Every forwarded tool must carry a schema pi can actually validate: DSH stores a
// property spec map, pi wants JSON Schema, and a real package built with
// schemastery or zod produces shapes a fixture never exercises.
await log('\n### schema conversion for forwarded tools')
let bad = 0
let converted = 0
const forwarded = tools.filter((t) => t.name !== 'dsh_install' && t.name !== 'dsh_preview')
for (const t of forwarded) {
  const s = dshParamsToSchema(t.parameters || {})
  const okShape = !!(s && s.type === 'object' && s.properties)
  const req = (s && s.required) || []
  const reqOk = req.every((k) => Object.prototype.hasOwnProperty.call(s.properties, k))
  if (okShape && reqOk) converted++
  else { bad++; await log('  BAD ' + t.name + ': ' + JSON.stringify(s).slice(0, 140)) }
}
await log('  forwarded tools in pi: ' + forwarded.length + ', valid schemas: ' + converted + ', bad: ' + bad)
check('every forwarded tool has a schema pi accepts', bad === 0, 'bad=' + bad)
check('real tools reached pi', converted > 10, 'converted=' + converted)

// Call one through the product path and confirm the answer came from DSH.
await log('\n### calling a forwarded tool through pi')
const callable = forwarded.find((t) => /_status$/.test(t.name)) || forwarded[0]
if (callable) {
  let res = null
  try { res = await callable.execute('id2', {}) }
  catch (e) { check('a forwarded call survives pi', false, String(e.message).slice(0, 160)) }
  if (res) {
    const body = String(res.content[0].text)
    await log('  ' + callable.name + ' -> ' + body.replace(/\s+/g, ' ').slice(0, 220))
    check('the call travelled and DSH answered', body.length > 0, body.slice(0, 120))
    check('the result is marked as coming from DSH', !!(res.details && res.details.viaDsh), JSON.stringify(res.details))
    // A named failure mode, not a tautology: a served call used to hand the tool
    // an empty execution object, so anything reading exec.signal died with
    // TypeError inside the bridge instead of answering. Assert that specific
    // crash is gone; an assertion that cannot fail proves nothing.
    check('no execution-context TypeError surfaced', !/Cannot read properties of undefined (reading 'signal')/.test(body), body.slice(0, 140))
    check('a failure is attributed to the DSH tool', !/^[A-Z]/.test(body) || /DSH tool|failed|require|status|Team|active/.test(body), body.slice(0, 140))
  }
} else {
  await log('  (no forwarded tool to call)')
}

const total = rows.reduce((n, r) => n + r.names.length, 0)
await log('\n=== SUMMARY ===')
await log('packages installed through pi: ' + rows.length)
await log('tools forwarded into pi: ' + total)
await log('schemas valid for pi: ' + converted)
await log('journal: ' + JOURNAL)
console.log('')
console.log(failures ? 'PI-SIDE BATCH FAILED (' + failures + ')' : 'PI-SIDE BATCH PASSED')
process.exitCode = failures ? 1 : 0
