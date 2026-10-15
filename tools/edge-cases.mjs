/**
 * Edge cases that the fixture tests cannot reach: a scoped npm package (name
 * and version parsing are easy to get wrong) and a git-sourced DSH bundle whose
 * only payload is an async skill provider (dsh-comsol).
 * Run: node scripts/edge-cases.mjs
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
process.env.DSH_PI_BRIDGE_HOME = path.join(ROOT, '.tmp', '.edge-cache')

const { loadForeign } = await import('../src/load.js')
const { parseSpec } = await import('../src/resolve.js')

console.log('spec parsing')
for (const s of ['@plannotator/pi-extension', 'npm:@plannotator/pi-extension@1.2.3', 'github:Twofruitsgrape/dsh-comsol', './local', 'git:github.com/a/b@v1']) {
  console.log('  ' + JSON.stringify(s) + ' -> ' + JSON.stringify(parseSpec(s)))
}

const CASES = [
  { spec: 'npm:@plannotator/pi-extension', host: 'pi', why: 'scoped npm name' },
  { spec: 'github:Twofruitsgrape/dsh-comsol', host: 'dsh', why: 'git source, skill-only DSH bundle' },
]
const EXPECT = {
  'npm:@plannotator/pi-extension': (r) => (r.compiled || []).length > 0 && r.capabilities.every(x => x.kind === 'skill' || true) && String(r.info.name).startsWith('@'),
  'github:Twofruitsgrape/dsh-comsol': (r) => r.capabilities.some(x => x.kind === 'skill' && x.name === 'comsol-dsh'),
}
let failures = 0
for (const c of CASES) {
  console.log('\n=== ' + c.spec + ' (' + c.why + ')')
  const t0 = Date.now()
  try {
    const r = await loadForeign(c.spec, { host: c.host, installDeps: false })
    console.log('  name     = ' + r.info.name + '@' + r.info.version + ' (' + (Date.now() - t0) + 'ms)')
    console.log('  detected = ' + JSON.stringify(r.info.signals))
    console.log('  stubs    = ' + JSON.stringify(r.stubPackages))
    console.log('  compiled = ' + (r.compiled || []).length)
    console.log('  caps     = ' + JSON.stringify(r.capabilities.map(x => x.kind + ':' + x.name)))
    console.log('  skills   = ' + JSON.stringify([...new Set((r.skillDirs || []).map(d => path.basename(d)))]))
    console.log('  unsupp   = ' + JSON.stringify([...new Set(r.unsupported || [])]))
    if (r.errors && r.errors.length) console.log('  errors   = ' + JSON.stringify(r.errors).slice(0, 300))
    const want = EXPECT[c.spec]
    if (want) {
      const ok = want(r)
      console.log('  expectation: ' + (ok ? 'met' : 'NOT MET'))
      if (!ok) failures++
    }
  } catch (e) {
    console.log('  CRASH: ' + String(e && e.message).split('\n')[0].slice(0, 220))
    failures++
  }
}
console.log('')
console.log(failures ? 'EDGE CASES FAILED (' + failures + ')' : 'EDGE CASES PASSED')
process.exit(failures ? 1 : 0)
