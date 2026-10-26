/**
 * Self-host check: feed this package's own DSH entry through the bridge
 * pipeline (mirror, stub, capture) as if it were a foreign bundle. It exercises
 * the DSH entry conventions - name/inject/apply plus an async skill provider -
 * under exactly the machinery a real bridged bundle runs through.
 *
 * Run: node scripts/selfhost-check.mjs
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// A per-run home, not a stable one. The stable path made the suite delete its
// previous build tree (hundreds of files) before it could start, so a leftover
// directory turned a green suite into an error about the deletion - and a
// sandbox that guards bulk deletes into a hard failure. selftest.mjs already
// uses this shape; matching it removes a setup step that tests nothing.
process.env.DSH_PI_BRIDGE_HOME = path.join(os.tmpdir(), 'dsh-pi-bridge-selfhost-' + process.pid)

const { loadForeign } = await import('../src/load.js')
const { replayIntoPi } = await import('../src/replay-pi.js')

const r = await loadForeign(ROOT, { host: 'dsh' })
console.log('detected   = ' + JSON.stringify(r.info.signals))
console.log('stubs      = ' + JSON.stringify(r.stubPackages))
console.log('errors     = ' + JSON.stringify(r.errors))
console.log('caps       = ' + JSON.stringify(r.capabilities.map(c => c.kind + ':' + c.name)))
console.log('skillDirs  = ' + JSON.stringify((r.skillDirs || []).map(d => path.basename(d))))

const acc = { tools: [], commands: [], events: [] }
const pi = {
  registerTool: (t) => acc.tools.push(t),
  registerCommand: (n, o) => acc.commands.push({ name: n, description: o && o.description }),
  on: (n, h) => { acc.events.push({ n, h }); return () => {} },
}
const report = replayIntoPi(pi, r, { prefix: 'self' })
console.log('replay     = ' + JSON.stringify(report))
const want = ['self_pi_install', 'self_pi_preview', 'self_dsh_install', 'self_bridge_list', 'self_bridge_remove']
const got = acc.tools.map(t => t.name)
const missing = want.filter(w => !got.includes(w))
console.log(missing.length ? 'MISSING: ' + missing.join(',') : 'ALL 5 DSH TOOLS CROSSED INTO PI')
// 每个桥过来的工具都应可调用并返回 pi content 形状
const bad = []
try {
  for (const t of acc.tools) {
    const res = await t.execute('id', {}, undefined, undefined, {})
    const okRes = Array.isArray(res.content) && typeof res.content[0].text === 'string'
    if (!okRes) bad.push(t.name)
    console.log('  ' + t.name + ' -> ' + (okRes ? 'ok' : 'BAD') + ': ' + String(res.content[0].text).replace(/\s+/g, ' ').slice(0, 60))
  }
} finally {
  // bridge_status starts a pi daemon. Its piped stdio keeps this process alive,
  // so without this the suite printed every verdict and then hung - which reads
  // as an infrastructure failure, not a result. Stop it before reporting.
  const { stopDaemon } = await import('../src/proxy.js')
  await stopDaemon().catch(() => false)
}
if (bad.length) console.log('BAD RESULTS: ' + bad.join(','))
process.exit(missing.length || bad.length ? 1 : 0)
