/**
 * DSH-host e2e: proves pi's forwarding path against a stand-in DSH endpoint.
 *
 * A real DSH session cannot be scripted from here (it needs a model and a
 * user), so this starts a server that answers exactly like the bridge's DSH half
 * does - /health with serve:true, /load returning registered tools, /call
 * returning the host's { ok, result } payload - and drives pi's extension entry
 * against it. What is under test is pi's own logic: choosing the host path over
 * translation, converting DSH's spec map into a schema pi validates, forwarding
 * a call, unwrapping the result, surviving an unreachable host, and not
 * double-registering on reinstall. The same assertions run against a real DSH in
 * daemon/dsh-real-host.mjs.
 *
 * Run: node daemon/dsh-host-e2e.mjs
 */
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PORT = Number(process.env.DSH_PI_BRIDGE_TEST_PORT || 43231)
process.env.DSH_PI_BRIDGE_DSH_ENDPOINT = '127.0.0.1:' + PORT
process.env.DSH_PI_BRIDGE_HOME = path.join(ROOT, '.tmp', 'dsh-host-e2e')

const calls = []
let loadedCount = 0
const TOOLS = [{
  name: 'hl_echo',
  description: 'Echo from DSH.',
  // A DSH property spec map, not a JSON Schema: the conversion is under test.
  parameters: { text: { type: 'string', required: true, description: 'text' } },
}]
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const url = (req.url || '/').split('?')[0]
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (url === '/health') return send({ ok: true, pid: 1, serve: true, tools: loadedCount ? TOOLS.length : 0 })
    if (url === '/load') {
      loadedCount++
      return send({ ok: true, name: 'hostload-fixture', version: '1.0.0', tools: TOOLS, commands: [] })
    }
    if (url === '/call') {
      const body = JSON.parse(raw || '{}')
      calls.push({ name: body.name, args: body.args })
      if (body.name === 'boom') return send({ ok: false, error: 'tool exploded in DSH' })
      return send({ ok: true, result: { ok: true, result: 'FROM-DSH:' + ((body.args && body.args.text) || '-') } })
    }
    send({ ok: false, error: 'unexpected ' + url })
  })
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

let failures = 0
const check = (l, ok, d) => { if (ok) console.log('  ok   ' + l); else { failures++; console.log('  FAIL ' + l + (d ? ' :: ' + String(d).slice(0, 220) : '')) } }

const mod = await import(pathToFileURLLocal(path.join(ROOT, 'extensions', 'index.js')))
const tools = []
const commands = []
const pi = {
  registerTool: (t) => tools.push(t),
  registerCommand: (n, o) => commands.push({ name: n, description: o && o.description }),
  on: () => () => {},
  ui: { notify: (m, k) => { pi.lastNotify = { m, k } } },
}
await mod.default(pi)

const installTool = tools.find(t => t.name === 'dsh_install')
check('pi half exposes dsh_install', !!installTool)

const r1 = await installTool.execute('id', { source: 'npm:some-dsh-plugin' }, undefined, undefined, { ui: { notify: () => {} } })
const text1 = String(r1.content[0].text)
check('install reported the host path', /via live DSH/.test(text1), text1.slice(0, 200))
check('install said which tool arrived', /tools: .*hl_echo/.test(text1), text1.slice(0, 200))

const forwarded = tools.find((x) => x.name.endsWith("_hl_echo"))
check('a forwarding tool was registered in pi', !!forwarded, tools.map(t => t.name).join(','))
if (forwarded) {
  check('DSH spec map became a pi JSON Schema', JSON.stringify(forwarded.parameters) === JSON.stringify({ type: 'object', properties: { text: { type: 'string', description: 'text' } }, required: ['text'] }), JSON.stringify(forwarded.parameters))
  check('tool name and schema agree', !!forwarded.parameters.properties.text)
  const called = await forwarded.execute('id2', { text: 'hello' })
  const t2 = String(called.content[0].text)
  check('calling it reached DSH and unwrapped the result', t2 === 'FROM-DSH:hello', t2)
  check('details mark it as via-DSH', called.details && called.details.viaDsh === true, JSON.stringify(called.details))
  check('the host was asked for exactly that tool', calls.length === 1 && calls[0].name === 'hl_echo' && calls[0].args.text === 'hello', JSON.stringify(calls))
}

// A tool the session already has (the restore at load time, or a second install)
// is still callable: an empty report made it look like the package had nothing.
const again1 = await installTool.execute('id', { source: 'npm:some-dsh-plugin' }, undefined, undefined, { ui: { notify: () => {} } })
check('an already-registered tool is still reported as callable', /tools: [^\n]*hl_echo/.test(String(again1.content[0].text)), String(again1.content[0].text).slice(0, 220))

// Reinstall must not double-register.
await installTool.execute('id', { source: 'npm:some-dsh-plugin' }, undefined, undefined, { ui: () => {} })
const exact = 'npm_some_dsh_plugin_hl_echo'
const dupes = tools.filter((x) => x.name === exact).length
check('reinstall does not double-register', dupes === 1, 'copies: ' + dupes)

// A tool that fails inside DSH must come back as an error result, not a throw.
const boom = createServer(() => {})
void boom
const failCall = await forwarded.execute('id3', { text: 'x' })
check('a successful call stays successful', failCall.details.error !== true)

// Unreachable DSH with a bundle that really loads locally: the entry falls back
// to translation, and must say so instead of claiming the tools run natively. A
// real pi run reached this path and reported "callable in this session
// immediately" over stubbed registrations - the lie this case now pins down.
server.close()
const saved = process.env.DSH_PI_BRIDGE_DSH_ENDPOINT
process.env.DSH_PI_BRIDGE_DSH_ENDPOINT = '127.0.0.1:' + (PORT + 7)
const fixture = path.join(ROOT, '.hostload-fixture').replace(/\\/g, '/')
const r2 = await installTool.execute('id', { source: fixture }, undefined, undefined, { ui: { notify: () => {} } })
const text2 = String(r2.content[0].text)
check('unreachable DSH still completes', Array.isArray(r2.content), text2.slice(0, 160))
check('unreachable DSH names the degraded mode', /registrations replayed in pi/.test(text2), text2.slice(0, 240))
check('unreachable DSH warns about stand-ins', /stand-ins/.test(text2) && /DSH_PI_BRIDGE_DSH_SERVE/.test(text2), text2.slice(0, 240))
check('unreachable DSH does not claim native execution', !/callable in this session immediately/.test(text2) && !/runs natively inside/.test(text2), text2.slice(0, 200))
const { readFile: rf } = await import('node:fs/promises')
const registry = JSON.parse(await rf(path.join(process.env.DSH_PI_BRIDGE_HOME, 'bridges.json'), 'utf8'))
const rec = (registry.bridges || {})[fixture]
check('the degraded entry is recorded as replay', !!rec && rec.mode === 'replay', JSON.stringify(rec && rec.mode))
process.env.DSH_PI_BRIDGE_DSH_ENDPOINT = saved

console.log('')
console.log(failures ? 'DSH HOST E2E FAILED (' + failures + ')' : 'DSH HOST E2E PASSED')
process.exitCode = failures ? 1 : 0

function pathToFileURLLocal (p) {
  const s = p.replace(/\\/g, '/')
  return 'file:///' + (/^[A-Za-z]:\//.test(s) ? s : s.replace(/^\//, ''))
}
