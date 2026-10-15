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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
process.env.DSH_PI_BRIDGE_HOME = path.join(ROOT, '.tmp', '.selfhost-cache')

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
for (const t of acc.tools) {
  const res = await t.execute('id', {}, undefined, undefined, {})
  const okRes = Array.isArray(res.content) && typeof res.content[0].text === 'string'
  console.log('  ' + t.name + ' -> ' + (okRes ? 'ok' : 'BAD') + ': ' + String(res.content[0].text).replace(/\s+/g, ' ').slice(0, 60))
}
