/**
 * Entry load test: import the DSH half (index.js) and call apply() against a
 * recording stand-in scope. The entry modules are the pieces the unit self-test
 * does not cover, and they are what each host actually loads.
 *
 * Run: node scripts/entry-check.mjs
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
process.env.DSH_PI_BRIDGE_HOME = path.join(ROOT, 'scripts', '.entry-cache')

let failures = 0
function check (label, cond, detail) {
  if (cond) console.log('  ok   ' + label)
  else { failures++; console.log('  FAIL ' + label + (detail ? ' :: ' + detail : '')) }
}

// ---- DSH half -------------------------------------------------------------
const mod = await import('../index.js')
check('exports name', mod.name === 'dsh-pi-bridge', String(mod.name))
check('exports inject', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
check('exports apply', typeof mod.apply === 'function')
check('default export object', mod.default && typeof mod.default.apply === 'function')

const tools = [], commands = [], skills = [], events = []
const ctx = {
  logger: { info (m) { events.push('log:' + m) }, warn () {}, error () {}, debug () {} },
  tools: { register: (t) => tools.push(t) },
  commands: { register: (d) => commands.push(d) },
  skills: { registerProvider: (f) => skills.push(f) },
  on: (n, h) => events.push(n),
  inject (names, fn) {
    const scope = { tools: ctx.tools, skills: ctx.skills }
    for (const n of names) if (!(n in scope)) return undefined
    return fn(scope)
  },
}
await mod.apply(ctx, {})
const names = tools.map(t => t.name)
for (const want of ['pi_install', 'pi_preview', 'dsh_install', 'bridge_list', 'bridge_remove']) {
  check('DSH tool registered: ' + want, names.includes(want), JSON.stringify(names))
}
check('tools carry output schema', tools.every(t => t.output && t.output.schema && t.output.schema.properties.ok))
check('self skill mounted through inject', skills.length === 1, 'providers=' + skills.length)

// The guard must turn failures into a value, never a throw.
const bad = tools.find(t => t.name === 'pi_preview')
const errOut = await bad.execute({}, {})
check('missing argument is guarded', errOut.ok === false && /dsh-pi-bridge/.test(errOut.result), JSON.stringify(errOut))

// ---- pi half --------------------------------------------------------------
const piMod = await import('../extensions/index.js')
const factory = piMod.default
check('pi entry default factory', typeof factory === 'function')
check('pi factory is async (restore runs at load)', factory.constructor.name === 'AsyncFunction', factory.constructor.name)
const pi = { tools: [], commands: [], events: [] }
pi.registerTool = (t) => pi.tools.push(t)
pi.registerCommand = (n, o) => pi.commands.push({ name: n, ...o })
pi.on = (n, h) => { pi.events.push({ n, h }); return () => {} }
pi.ui = { notify: () => {} }
await factory(pi)
const cmdNames = pi.commands.map(c => c.name)
for (const want of ['/dsh-install', '/dsh-preview', '/bridge-list', '/bridge-remove']) {
  check('pi command registered: ' + want, cmdNames.includes(want.slice(1)), JSON.stringify(cmdNames))
}
const toolNames = pi.tools.map(t => t.name)
check('pi tools registered', toolNames.includes('dsh_install') && toolNames.includes('dsh_preview'), JSON.stringify(toolNames))
check('pi tool params are JSON Schema', pi.tools[0].parameters.type === 'object' && pi.tools[0].parameters.required.includes('source'))

const noArgs = await pi.tools[0].execute('tc', { source: '' }, undefined, undefined, { ui: { notify: () => {} } })
check('pi tool reports failure as content, not throw', Array.isArray(noArgs.content) && typeof noArgs.content[0].text === 'string', JSON.stringify(noArgs).slice(0, 200))

console.log('')
console.log(failures ? 'ENTRY CHECK FAILED (' + failures + ')' : 'ENTRY CHECK PASSED')
process.exit(failures ? 1 : 0)
