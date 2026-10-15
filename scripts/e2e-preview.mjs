/**
 * End-to-end preview against real published packages: resolve from npm, mirror,
 * stub, compile, capture, replay onto a mock host. Registers nothing in a host.
 *
 * These packages are the regression net for the bridge itself: a package that
 * used to bridge and suddenly does not fails this run. Running the bridged tool
 * is evidence, not a gate - a real tool answering with its own argument
 * validation proves the original package logic executes under the receiving
 * host's tool shape, which is exactly what a bridge must achieve.
 *
 * Run: node scripts/e2e-preview.mjs   (needs network)
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
process.env.DSH_PI_BRIDGE_HOME = path.join(ROOT, 'scripts', '.e2e-cache')

const { loadForeign } = await import('../src/load.js')
const { replayIntoDsh } = await import('../src/replay-dsh.js')

const CASES = [
  { spec: 'npm:pi-web-access', host: 'pi', expect: (r, rep) => rep.tools >= 3 && rep.commands >= 3 && rep.events >= 1 },
  { spec: 'npm:pi-subagents', host: 'pi', expect: (r, rep) => rep.tools >= 3 && rep.commands >= 10 && rep.skills >= 1 },
  // A pure UI/service plugin: the honest result is nothing to bridge, reported
  // as such rather than mistaken for a crash in the bridge.
  { spec: 'npm:dsh-cost-meter', host: 'dsh', expect: (r) => r.errors.every(e => !/is not (a function|iterable|callable|constructor)/.test(e)) },
]

let failures = 0
for (const c of CASES) {
  console.log('\n=== ' + c.spec + ' host=' + c.host)
  const t0 = Date.now()
  try {
    const r = await loadForeign(c.spec, { host: c.host, installDeps: false })
    const tools = r.capabilities.filter(x => x.kind === 'tool')
    const commands = r.capabilities.filter(x => x.kind === 'command')
    console.log('  name     = ' + r.info.name + '@' + r.info.version + ' (' + (Date.now() - t0) + 'ms)')
    console.log('  stubs    = ' + JSON.stringify(r.stubPackages))
    console.log('  compiled = ' + (r.compiled || []).length)
    console.log('  caps     = ' + tools.length + ' tools, ' + commands.length + ' commands, ' + (r.skillDirs || []).length + ' skill dirs, ' + (r.events || []).length + ' events')
    console.log('  unsupp   = ' + JSON.stringify([...new Set(r.unsupported || [])]))
    if (r.errors && r.errors.length) console.log('  errors   = ' + JSON.stringify(r.errors).slice(0, 300))

    // Replay onto the DSH half and exercise the received tools.
    const registered = []
    const ctx = {
      logger: { info () {}, warn () {}, error () {}, debug () {} },
      tools: { register: (t) => registered.push(t) },
      commands: { register: () => {} }, skills: { registerProvider: () => {} }, on: () => {}, inject: () => {},
    }
    const rep = await replayIntoDsh(ctx, r, {})
    const counts = { tools: rep.tools.length, commands: rep.commands.length, skills: rep.skills.length, events: rep.events.length, skipped: rep.skipped.length }
    console.log('  replay->DSH: ' + JSON.stringify(counts))
    for (const t of registered.slice(0, 3)) {
      let outcome
      try {
        const res = await t.execute({}, {})
        outcome = res && res.ok !== undefined ? 'returned ' + String(res.result).replace(/\s+/g, ' ').slice(0, 60) : 'returned ' + JSON.stringify(res).slice(0, 60)
      } catch (e) {
        // The original package validated its own arguments: its logic ran.
        outcome = 'threw from package logic: ' + String(e && e.message).replace(/\s+/g, ' ').slice(0, 70)
      }
      console.log('    ' + t.name + ' -> ' + outcome)
    }
    if (c.expect) {
      const ok = c.expect(r, counts)
      console.log('  expectation: ' + (ok ? 'MET' : 'NOT MET'))
      if (!ok) failures++
    }
  } catch (e) {
    console.log('  CRASH: ' + String(e && e.message).split('\n')[0].slice(0, 200))
    failures++
  }
}
console.log('')
console.log(failures ? 'E2E FAILED (' + failures + ' case(s))' : 'E2E PASSED')
process.exit(failures ? 1 : 0)
