/**
 * End-to-end preview against real published packages: resolves from the npm
 * registry, mirrors, stubs, compiles, captures, prints what would arrive.
 * Registers nothing. Run: node scripts/e2e-preview.mjs
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
process.env.DSH_PI_BRIDGE_HOME = path.join(ROOT, 'scripts', '.e2e-cache')

const { loadForeign } = await import('../src/load.js')
const { replayIntoDsh } = await import('../src/replay-dsh.js')

const CASES = [
  { spec: 'npm:pi-web-access', host: 'pi' },
  { spec: 'npm:pi-subagents', host: 'pi' },
  { spec: 'npm:dsh-cost-meter', host: 'dsh' },
]

for (const c of CASES) {
  console.log('\n=== ' + c.spec + ' host=' + c.host)
  const t0 = Date.now()
  try {
    const r = await loadForeign(c.spec, { host: c.host, installDeps: true })
    console.log('  name     = ' + r.info.name + '@' + r.info.version + ' (' + (Date.now() - t0) + 'ms)')
    console.log('  stubs    = ' + JSON.stringify(r.stubPackages))
    console.log('  compiled = ' + (r.compiled || []).length)
    console.log('  caps     = ' + JSON.stringify(r.capabilities.map(x => x.kind + ':' + x.name)))
    console.log('  skills   = ' + JSON.stringify([...new Set((r.skillDirs || []).map(d => path.basename(d)))]))
    console.log('  events   = ' + JSON.stringify([...new Set((r.events || []).map(e => e.event))]))
    console.log('  unsupp   = ' + JSON.stringify([...new Set(r.unsupported || [])]))
    if (r.errors && r.errors.length) console.log('  errors   = ' + JSON.stringify(r.errors).slice(0, 400))
    if (c.host === 'pi') {
      const registered = []
      const ctx = {
        logger: { info () {}, warn () {}, error () {}, debug () {} },
        tools: { register: (t) => registered.push(t) },
        commands: { register: () => {} }, skills: { registerProvider: () => {} }, on: () => {}, inject: () => {},
      }
      const rep = await replayIntoDsh(ctx, r, {})
      console.log('  replay->DSH: ' + JSON.stringify({ tools: rep.tools.length, commands: rep.commands.length, skills: rep.skills.length, skipped: rep.skipped.length }))
      for (const t of registered.slice(0, 2)) {
        const out = await t.execute({}, {})
        console.log('    ' + t.name + ' -> ' + String(out.result).replace(/\s+/g, ' ').slice(0, 70))
      }
    }
  } catch (e) {
    console.log('  CRASH: ' + String(e && e.message).split('\n')[0].slice(0, 200))
  }
}
console.log('')
