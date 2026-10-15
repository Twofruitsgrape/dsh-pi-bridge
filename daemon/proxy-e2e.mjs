/**
 * Proxy end-to-end: the exact call sequence the DSH half will use, run as a test.
 *
 * Starts the daemon through the client module (not a hand-spawned process), so
 * ensureDaemon's own startup path is what gets verified, then materializes,
 * loads and calls a package, and asserts the result came from pi's runtime.
 *
 * Run: node daemon/proxy-e2e.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TMP = path.join(ROOT, '.tmp', 'proxy-e2e')
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })

// The daemon keeps its own state under the cache root; point it at the scratch
// tree so the test does not depend on a writable home directory.
process.env.DSH_PI_BRIDGE_HOME = TMP

const { ensureDaemon, materialize, loadIntoPi, listTools, callTool } = await import('../src/proxy.js')

let failures = 0
function check (label, cond, detail) {
  if (cond) console.log('  ok   ' + label)
  else { failures++; console.log('  FAIL ' + label + (detail ? ' :: ' + String(detail).slice(0, 240) : '')) }
}

// A package with real published dependencies, so the "stubs make it unusable"
// failure mode is actually exercised: fetch_content needs undici and linkedom.
const real = path.join(TMP, 'dep-checking-package')
await mkdir(path.join(real, 'extensions'), { recursive: true })
await writeFile(path.join(real, 'package.json'), JSON.stringify({
  name: 'dep-checking-package', version: '1.0.0', type: 'module',
  keywords: ['pi-package'], pi: { extensions: ['./extensions'] },
  dependencies: { 'promise.try': '*' },
}, null, 2), 'utf8')
// promise.try publishes its function as the module export (module.exports = fn),
// so the correct import is a default one. The previous version named a binding
// that does not exist; that was this test's bug, and the bridge surfaced it as a
// plain error result instead of hanging, which is the behaviour we want.
await writeFile(path.join(real, 'extensions', 'index.js'), [
  'import promiseTry from "promise.try";',
  '',
  'export default function (pi) {',
  '  pi.registerTool({',
  '    name: "dep_probe",',
  '    label: "Dependency probe",',
  '    description: "Prove a published dependency loads inside pi.",',
  '    parameters: { type: "object", properties: {}, additionalProperties: false },',
  '    async execute () {',
  '      const r = await promiseTry(() => "dep-ok")',
  '      return { content: [{ type: "text", text: String(r) }] }',
  '    },',
  '  });',
  '}',
  '',
].join('\n'), 'utf8')

try {
  const h = await ensureDaemon({ log: (m) => console.log('  [' + m + ']') })
  check('client started the daemon', !!(h && h.ok && h.ctx), JSON.stringify(h))

  const m = await materialize(real, {})
  check('materialize resolved a package root', !!(m.root && m.info.name), JSON.stringify(m).slice(0, 200))
  check('materialize installed the published dependency', m.dependencies && m.dependencies.status === 'installed', JSON.stringify(m.dependencies))

  const loaded = await loadIntoPi(m, {})
  check('loadIntoPi registered the tool', !!(loaded.ok && (loaded.added || []).some(t => t.name === 'dep_probe')), JSON.stringify(loaded).slice(0, 240))

  const list = await listTools()
  check('tool is listed as bridge-loaded', (list.tools || []).some(t => t.name === 'dep_probe' && t.origin === 'bridge'))

  const r = await callTool('dep_probe', {})
  const text = r && r.result && r.result.content && String((r.result.content[0] || {}).text || '')
  check('published dependency loaded and ran inside pi', !!r.ok && text === 'dep-ok', JSON.stringify(r).slice(0, 240))

  const missing = await callTool('no_such_tool', {})
  check('unknown tool refused', !missing.ok && /unknown tool/.test(String(missing.error)), JSON.stringify(missing))
} catch (e) {
  check('proxy end-to-end completed', false, (e && e.message) || String(e))
}

// Leave no orphan: the daemon closes its own pi child on /shutdown. If that
// request fails the daemon was already down, which is the other acceptable end.
try {
  const http = await import('node:http')
  await new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: 43117, path: '/shutdown', method: 'GET', agent: false, timeout: 5000 }, (r) => { r.resume(); r.on('end', res) })
    req.on('error', res)
    req.on('timeout', () => { req.destroy(); res() })
    req.end()
  })
  console.log('  [daemon shutdown requested]')
} catch { /* already gone */ }

console.log('')
console.log(failures ? 'PROXY E2E FAILED (' + failures + ')' : 'PROXY E2E PASSED')
process.exitCode = failures ? 1 : 0
