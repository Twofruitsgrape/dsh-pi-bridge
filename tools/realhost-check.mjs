/**
 * Real-host acceptance: hand the object the DSH replay produces to the actual
 * @deepseek-ai/dsh-tools from an installed DSH build, and require that host
 * defineTool compile it, run it, and reject invalid arguments.
 *
 * The offline suite asserts against a mock, which cannot catch a shape the host
 * itself would refuse. This is skipped wherever no DSH build is installed, and
 * prints its own SKIP reason rather than failing a CI run on absence.
 *
 * Run: node scripts/realhost-check.mjs
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
process.env.DSH_PI_BRIDGE_HOME = path.join(ROOT, '.tmp', '.realhost-cache')

/**
 * Candidate locations of an installed DSH build's tools package.
 *
 * A packaged DSH keeps its node_modules inside app.asar, which only an
 * Electron-patched fs can read, so this check is meaningful when it runs inside
 * a host process (the harness itself, or `dsh`). Under plain Node it reports
 * why it skipped instead of pretending the host rejected us.
 */
function findHostTools () {
  // execPath is the most reliable answer: inside a host process it points at the
  // installed app, and env is often empty in a spawned tool sandbox.
  const roots = [
    process.env.DSH_APP_PATH,
    process.execPath && path.dirname(process.execPath),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DeepSeek Harness'),
  ].filter(Boolean)
  const inside = []
  for (const r of roots) {
    inside.push(path.join(r, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    inside.push(path.join(r, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  for (const cand of inside) {
    try { if (fs.existsSync(cand)) return cand } catch { /* unreadable */ }
  }
  return null
}

export function hostReachable () {
  return !!findHostTools()
}

export async function runRealHostCheck () {
const host = findHostTools()
if (!host) return { skipped: true, reason: 'no installed DSH build reachable (asar needs an Electron fs; run inside dsh or set DSH_APP_PATH)' }

let real
try { real = await import('file:///' + host.replace(/\\/g, '/')) }
catch (e) { return { skipped: true, reason: 'cannot import host dsh-tools: ' + String(e.message).slice(0, 100) } }
if (!real || typeof real.defineTool !== 'function') return { skipped: true, reason: 'host defineTool unavailable' }

const { loadForeign } = await import('../src/load.js')
const cap = (await loadForeign(path.join(HERE, 'fixtures', 'pi-demo'), { host: 'pi' })).capabilities.find(c => c.kind === 'tool')
if (!cap) return { failures: ['fixture tool was not captured'] }

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    result: { type: 'string', required: true },
  },
}

// Exactly the shape replayIntoDsh passes to ctx.tools.register in production.
const definition = {
  name: 'realhost_demo_echo',
  description: cap.description + ' [bridged by dsh-pi-bridge from pi]',
  parameters: cap.spec,
  output: {
    schema: OUT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: (value && value.result) || '' }],
  },
  execute: async (args) => {
    const out = await cap.run(args, {})
    return { ok: true, result: out.text || JSON.stringify(out.structured === undefined ? null : out.structured) }
  },
}

const failures = []
function check (label, cond, detail) {
  if (cond) console.log('  ok   ' + label)
  else { failures.push(label + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + label + (detail ? ' :: ' + detail : '')) }
}

let compiled = null
let rejection = ''
try { compiled = real.defineTool(definition) } catch (e) { rejection = String(e && e.message).slice(0, 200) }
check('host defineTool accepts the bridged definition', !!compiled, rejection)
if (!compiled) return { failures }

console.log('  host-compiled parameters = ' + JSON.stringify(compiled.parameters))
// The host and pi must be handed the same schema for the same tool.
const hostJson = JSON.stringify(compiled.parameters)
const piJson = JSON.stringify(cap.schema)
check('host and pi receive equivalent parameter schemas', hostJson === piJson, 'host=' + hostJson + ' pi=' + piJson)

const good = await compiled.execute({ text: 'host-verify' }, {})
check('bridged tool runs under the host', good && good.ok === true && good.result === 'HOST-VERIFY', JSON.stringify(good))
check('host output render works', Array.isArray(compiled.output.render({}, good)) && compiled.output.render({}, good)[0].text === 'HOST-VERIFY')

let validation = ''
try { await compiled.execute({}, {}) } catch (e) { validation = String(e && e.name || e) }
check('host validates required arguments', /ToolArgsError|invalid arguments/.test(validation), validation || 'no error raised')

return { failures }
}

// Direct execution: report and exit; importing the module stays side-effect free.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/realhost-check.mjs')) {
  const result = await runRealHostCheck()
  if (result.skipped) { console.log('SKIP: ' + result.reason); process.exit(0) }
  console.log('')
  console.log(result.failures.length ? 'REALHOST CHECK FAILED (' + result.failures.length + ')' : 'REALHOST CHECK PASSED')
  process.exit(result.failures.length ? 1 : 0)
}
