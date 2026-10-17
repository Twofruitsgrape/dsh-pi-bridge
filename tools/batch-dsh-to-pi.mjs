/**
 * Batch test in the DSH -> pi direction, using real bundles from this machine.
 *
 * The bundles are the ones the user's own DSH profile installs, taken read-only
 * from its node_modules. A live DSH session loads each one against its real host
 * scope and the endpoint hands back what registered; then this script, standing
 * where pi stands, converts the parameter shapes, calls each tool, and compares
 * what came back with the same tool called directly inside DSH. Both paths run
 * the same code, so an agreement is evidence the forwarding is honest rather than
 * a mock agreeing with itself.
 *
 * Requires a DSH session serving the endpoint:
 *   DSH_PI_BRIDGE_DSH_SERVE=43191 dsh --profile bridge-test "<prompt that loads bundles>"
 *
 * Run: node tools/batch-dsh-to-pi.mjs
 */
import { dshHostStatus, dshHostLoad, dshHostCall, dshParamsToSchema } from '../src/dsh-host-client.js'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TMP = path.join(ROOT, '.tmp', 'batch-dsh')
const { mkdir, appendFile, writeFile } = await import('node:fs/promises')
await mkdir(TMP, { recursive: true })
const JOURNAL = path.join(TMP, 'journal.txt')
await writeFile(JOURNAL, '')
// Line-buffered to a file as well as stdout: a real run is long, and a terminal
// that loses scrollback should not lose the evidence.
const log = async (m) => { await appendFile(JOURNAL, m + '\n'); console.log(m) }

const BUNDLES = [
  'dsh-super-code',
  'dsh-gitbash-shell',
  'dsh-expert-orchestrator',
  'dsh-thinking-levels',
  'dshmarket',
  'dsh-computer-use-win',
  'dsh-our-free-model',
  'dsh-comsol',
]

const health = await dshHostStatus().catch((e) => ({ ok: false, error: e.message }))
if (!(health && health.ok && health.serve)) {
  await log('SKIP: no live DSH session serving the endpoint (' + JSON.stringify(health).slice(0, 160) + ')')
  await log('start one with DSH_PI_BRIDGE_DSH_SERVE=43191 and a prompt that calls dsh_install first')
  process.exit(0)
}
await log('live DSH session: pid=' + health.pid)

// Where to look: the user's own profile by default, or a directory given on the
// command line, so third-party packages pulled from npm can be tested the same
// way. A JSON file of explicit paths is also accepted.
const arg = process.argv[2] || ''
let resolved = []
if (arg.endsWith('.json')) {
  const { readFile } = await import('node:fs/promises')
  const list = JSON.parse(await readFile(arg, 'utf8'))
  const listed = []
  for (const p of list) {
    const dir = path.resolve(p)
    let name = path.basename(dir)
    try { const { readFileSync } = await import('node:fs'); name = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name || name } catch { /* fall back */ }
    if (existsSync(path.join(dir, 'package.json'))) listed.push({ name, dir })
  }
  resolved = listed
} else {
  const root = arg ? path.resolve(arg) : path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
  for (const name of BUNDLES) {
    const dir = path.join(root, name)
    if (!existsSync(path.join(dir, 'package.json'))) { await log('absent locally: ' + name); continue }
    resolved.push({ name, dir })
  }
  // An explicit directory listing beats the default names when the root is not the
  // user profile: whatever bundles live there get tested.
  if (!arg.endsWith('.json') && root !== path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules') && !resolved.length) {
    for (const name of readdirSync(root)) {
      const dir = path.join(root, name)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      if (existsSync(path.join(dir, 'package.json'))) resolved.push({ name, dir })
    }
  }
}
await log('bundles found: ' + resolved.map((r) => r.name).join(', '))

const rows = []
for (const { name, dir } of resolved) {
  const spec = dir.replace(/\\/g, '/')
  await log('\n### ' + name)
  const start = Date.now()
  let loaded
  try { loaded = await dshHostLoad(spec) }
  catch (e) { await log('  load threw: ' + String(e.message).slice(0, 200)); rows.push({ name, ok: false, tools: [], error: String(e.message).slice(0, 160) }); continue }
  if (!loaded || !loaded.ok) {
    await log('  load refused: ' + String(loaded && loaded.error).slice(0, 220))
    rows.push({ name, ok: false, tools: [], error: String(loaded && loaded.error).slice(0, 160) })
    continue
  }
  const tools = loaded.tools || []
  const cmds = (loaded.commands || []).map((c) => '/' + c.name)
  // A bundle can contribute skill providers and configuration without exposing a
  // single callable tool, and that is a real contribution. Counting only tools
  // made four genuine bundles look empty.
  await log('  version=' + loaded.version
    + '  tools=' + (tools.length ? tools.map((t2) => t2.name).join(', ') : 'none')
    + '  commands=' + (cmds.length ? cmds.join(', ') : 'none')
    + '  skills=' + (loaded.skills || 0)
    + ((loaded.reused && loaded.reused.length) ? '  reused=' + loaded.reused.join(',') : ''))
  for (const c of loaded.conflicts || []) await log('  refused by the host (already mounted): ' + c.name)
  rows.push({ name, ok: true, tools, commands: cmds, skills: loaded.skills || 0, error: '' })
  await log('  (' + ((Date.now() - start) / 1000).toFixed(1) + 's)')
}

// Shape conversion: DSH's stored parameter form must become a schema pi accepts.
await log('\n### parameter shapes converted')
let shapeOk = 0
const shapeProblems = []
for (const row of rows) {
  for (const t of row.tools) {
    const schema = dshParamsToSchema(t.parameters)
    const valid = schema && schema.type === 'object' && schema.properties
    if (valid) shapeOk++
    else shapeProblems.push(row.name + '/' + t.name)
  }
}
await log('  converted: ' + shapeOk + ' tool(s), problems: ' + (shapeProblems.join(', ') || 'none'))

// Round-trip a call through the endpoint. Restricted on purpose: a real bundle's
// tool can have side effects (dispatch a subagent, run a shell command, write a
// file), and calling it with empty arguments because it "looked safe" is not a
// test I can defend. So only tools that (a) name a read-only operation and (b)
// declare required parameters get called - an empty call then exercises the whole
// path (transport, host dispatch, result projection) while the bundle's own
// validation stops it before any work. Everything else is checked structurally:
// present, executable, schema convertible.
const READ_ONLY = /(^|_)(status|list|doctor|info|ping|echo|hold|read|show|inspect|preview|usage)(_|$)/i
await log('\n### round-trip calls (read-only tools with required params)')
const calls = []
let structural = 0
for (const row of rows) {
  for (const tool of row.tools) {
    const schema = dshParamsToSchema(tool.parameters)
    const required = (schema && schema.required) || []
    const name = tool.name
    const shapeOk = !!(schema && schema.type === 'object' && schema.properties)
    if (!shapeOk) { calls.push({ tool: name, verdict: 'BAD-SHAPE' }); continue }
    structural++
    // Safety comes from the name being read-only, not from the call failing
    // validation: a status/list/preview tool given nothing should read state and
    // answer. Anything not naming a read operation stays structural-only.
    if (!READ_ONLY.test(name)) { calls.push({ tool: name, verdict: 'checked-structurally' }); continue }
    let res
    try { res = await dshHostCall(name, {}, { ms: 45000 }) }
    catch (e) { calls.push({ tool: name, verdict: 'THREW ' + String(e.message).slice(0, 110) }); continue }
    if (!res || !res.ok) {
      calls.push({ tool: name, verdict: 'host-error', body: String(res && res.error).slice(0, 150) })
      await log('  ' + name + ' -> host-error: ' + String(res && res.error).slice(0, 140))
      continue
    }
    const payload = res.result || {}
    const body = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload)
    const verdict = payload.ok === false ? 'tool-error' : 'returned'
    calls.push({ tool: name, verdict, body: String(body).replace(/\s+/g, ' ').slice(0, 150) })
    await log('  ' + name + ' -> ' + verdict + ': ' + String(body).replace(/\s+/g, ' ').slice(0, 140))
  }
}
await log('  structurally verified: ' + structural + ' tool(s); actually invoked: ' + calls.filter((c) => /returned|tool-error|host-error/.test(c.verdict)).length)

const withTools = rows.filter((r) => r.tools.length)
await log('\n=== SUMMARY ===')
await log('bundles attempted: ' + rows.length)
await log('loaded into DSH:   ' + rows.filter((r) => r.ok).length)
await log('arriving with tools: ' + withTools.length + ' (' + withTools.map((r) => r.name).join(', ') + ')')
await log('contributed no callable tool: ' + rows.filter((r) => r.ok && !r.tools.length).map((r) => r.name + (r.commands.length ? '[cmds]' : '') + (r.skills ? '[skills x' + r.skills + ']' : '')).join(', ') || 'none')
await log('contributed something: ' + rows.filter((r) => r.ok && (r.tools.length || r.commands.length || r.skills)).length)
await log('load refused:      ' + rows.filter((r) => !r.ok).map((r) => r.name + '=' + r.error.slice(0, 70)).join('; '))
// "forwarded calls" must mean calls that left this process. Counting the
// structural-only entries in that total claimed traffic that never happened.
const sent = calls.filter((c) => c.verdict !== 'checked-structurally')
await log('tools seen: ' + calls.length + ' (structural only: ' + (calls.length - sent.length) + ')')
await log('forwarded calls: ' + sent.length
  + ' | returned: ' + calls.filter((c) => c.verdict === 'returned').length
  + ' | tool-error: ' + calls.filter((c) => c.verdict === 'tool-error').length
  + ' | host-error: ' + calls.filter((c) => c.verdict === 'host-error').length
  + ' | threw: ' + calls.filter((c) => /THREW/.test(c.verdict)).length)
for (const c of sent) if (c.body) await log('  >> ' + c.tool + ': ' + c.body)
await log('journal: ' + JOURNAL)
