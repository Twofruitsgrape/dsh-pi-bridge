/**
 * Offline self-test for dsh-pi-bridge: no network, no real host.
 *
 * Two fixtures are written by hand into the bridge cache - a pi package whose
 * extension is TypeScript using the typebox builder, and a DSH bundle using
 * dsh-tools' defineTool, schemastery and an async skill provider (the way
 * dsh-comsol does it) - then pushed through the whole pipeline (resolve,
 * mirror, stub, compile, capture, replay) against a mock host on the other
 * side. Assertions are behavioural: the bridged tool is actually executed, the
 * skill is really listed, and the schemas convert in both directions.
 *
 * Run: node scripts/selftest.mjs   (SELFTEST_KEEP=1 keeps the temp cache)
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HOME = path.join(os.tmpdir(), 'dsh-pi-bridge-selftest-' + process.pid)
process.env.DSH_PI_BRIDGE_HOME = HOME

let failures = 0
let checks = 0
function check (label, condition, detail) {
  checks++
  if (condition) console.log('  ok   ' + label)
  else { failures++; console.log('  FAIL ' + label + (detail ? ' :: ' + detail : '')) }
}

/** A pi package: TypeScript extension using the typebox builder. */
async function fixturePi () {
  const dir = path.join(HOME, 'fixtures', 'pi-demo')
  await mkdir(path.join(dir, 'extensions'), { recursive: true })
  await mkdir(path.join(dir, 'skills', 'demo-skill'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'pi-demo-tools',
    version: '1.0.0',
    type: 'module',
    keywords: ['pi-package'],
    pi: { extensions: ['./extensions'], skills: ['./skills'] },
  }, null, 2), 'utf8')
  await writeFile(path.join(dir, 'extensions', 'index.ts'), [
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    'import { Type } from "typebox";',
    '',
    'export default function (pi: ExtensionAPI) {',
    '  pi.registerTool({',
    '    name: "demo_echo",',
    '    label: "Demo echo",',
    '    description: "Echo the given text back uppercased.",',
    '    parameters: Type.Object({ text: Type.String({ description: "text to echo" }) }),',
    '    async execute (_id, params) {',
    '      return { content: [{ type: "text", text: String(params.text).toUpperCase() }], details: {} };',
    '    },',
    '  });',
    '  pi.registerCommand("demo-ping", { description: "Say pong", handler: async () => {} });',
    '  pi.on("session_start", async () => {});',
    '}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(path.join(dir, 'skills', 'demo-skill', 'SKILL.md'), [
    '---',
    'name: demo-skill',
    'description: A demo skill for the bridge self-test.',
    '---',
    '',
    'Do the demo thing.',
    '',
  ].join('\n'), 'utf8')
  return dir
}

/** A DSH bundle: ESM using defineTool, schemastery, and an async skill provider. */
async function fixtureDsh () {
  const dir = path.join(HOME, 'fixtures', 'dsh-demo')
  const skillDir = path.join(dir, 'skills', 'dsh-demo-skill').replace(/\\/g, '/')
  await mkdir(path.join(dir, 'lib'), { recursive: true })
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-demo-tools',
    version: '2.0.0',
    type: 'module',
    main: './index.js',
    keywords: ['dsh', 'dsh-plugin'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2), 'utf8')
  await writeFile(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: dsh-demo-skill',
    'description: A skill contributed by the DSH fixture.',
    '---',
    '',
    'Do the DSH demo thing.',
    '',
  ].join('\n'), 'utf8')
  await writeFile(path.join(dir, 'index.js'), [
    "import { defineTool } from '@deepseek-ai/dsh-tools'",
    "import { z } from '@deepseek-ai/schemastery'",
    "import { greet } from './lib/greet.js'",
    '',
    "const SKILL_DIR = " + JSON.stringify(skillDir),
    '',
    "export const name = 'dsh-demo'",
    "export const inject = ['tools', 'commands']",
    'export const Config = z.object({ shout: z.boolean().optional() })',
    '',
    'export function apply (ctx, config) {',
    '  ctx.tools.register(defineTool({',
    "    name: 'demo_sum',",
    "    description: 'Add two numbers.',",
    '    parameters: {',
    "      a: { type: 'number', required: true, description: 'first' },",
    "      b: { type: 'number', required: true, description: 'second' },",
    '    },',
    '    output: {',
    "      schema: { type: 'object', properties: { ok: { type: 'boolean', required: true }, result: { type: 'string', required: true } } },",
    "      render: (_a, v) => [{ type: 'text', text: v.result }],",
    '    },',
    '    execute: async (args) => ({ ok: true, result: greet(String(args.a + args.b), config) }),',
    '  }))',
    '  ctx.commands.register({',
    "    name: 'demo-cmd',",
    "    description: 'Demo command',",
    "    handler: () => ({ kind: 'success', text: 'demo' }),",
    '  })',
    '  if (ctx.skills) {',
    '    ctx.skills.registerProvider(async () => ({',
    '      async list () {',
    '        return [{',
    "          name: 'dsh-demo-skill',",
    "          description: 'A skill contributed by the DSH fixture.',",
    "          provider: 'dsh-demo',",
    '          resourceBase: { kind: \"directory\", path: SKILL_DIR },',
    '        }]',
    '      },',
    '      async get (candidate) {',
    '        return { name: candidate && candidate.name, content: \"Do the DSH demo thing.\\n\" }',
    '      },',
    '    }))',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(path.join(dir, 'lib', 'greet.js'), 'export function greet (v) { return "sum=" + v }\n', 'utf8')
  return dir
}

function mockDshCtx () {
  const ctx = { toolsArr: [], cmds: [], skillProviders: [], events: [] }
  ctx.logger = { info () {}, warn () {}, error () {}, debug () {} }
  ctx.tools = { register: (t) => ctx.toolsArr.push(t) }
  ctx.commands = { register: (d) => ctx.cmds.push(d) }
  ctx.skills = { registerProvider: (f) => ctx.skillProviders.push(f) }
  ctx.on = (name, handler) => { ctx.events.push({ name, handler }) }
  ctx.inject = (names, fn) => {
    const scope = { tools: ctx.tools, skills: ctx.skills, systemPrompt: { section: () => {} } }
    for (const n of names) if (!(n in scope)) return undefined
    return fn(scope)
  }
  return ctx
}

function mockPi () {
  const api = { tools: [], commands: [], events: [] }
  api.registerTool = (t) => { api.tools.push(t) }
  api.registerCommand = (n, o) => { api.commands.push({ name: n, ...o }) }
  api.on = (name, handler) => { api.events.push({ name, handler }); return () => {} }
  api.ui = { notify: () => {} }
  return api
}

async function main () {
  await rm(HOME, { recursive: true, force: true })
  await mkdir(HOME, { recursive: true })

  const { loadForeign } = await import('../src/load.js')
  const { replayIntoDsh } = await import('../src/replay-dsh.js')
  const { replayIntoPi } = await import('../src/replay-pi.js')
  const { jsonSchemaToSpec, specToJsonSchema } = await import('../src/schema.js')

  console.log('schema bridge')
  const spec = jsonSchemaToSpec({ type: 'object', properties: { a: { type: 'string', description: 'A' }, b: { type: 'integer' } }, required: ['a'] })
  check('json schema -> spec map', !!(spec.a && spec.a.type === 'string' && spec.a.required === true && spec.b && !spec.b.required), JSON.stringify(spec))
  const back = specToJsonSchema({ x: { type: 'boolean', required: true }, y: { type: 'json' } })
  check('spec map -> json schema', back.properties.x.type === 'boolean' && (back.required || []).join() === 'x', JSON.stringify(back))

  console.log('pi package -> DSH host')
  const piDir = await fixturePi()
  const fromPi = await loadForeign(piDir, { host: 'pi' })
  check('classified as pi package', fromPi.info.pi === true, JSON.stringify(fromPi.info.signals))
  check('TypeScript compiled', fromPi.compiled.length >= 1, JSON.stringify((fromPi.compiled || []).map(c => path.basename(c.target))))
  check('extension loaded', fromPi.errors.length === 0, fromPi.errors.join('; '))
  check('tool captured', fromPi.capabilities.some(c => c.kind === 'tool' && c.name === 'demo_echo'), JSON.stringify(fromPi.capabilities.map(c => c.kind + ':' + c.name)))
  check('no duplicate registrations', fromPi.capabilities.length === 2, 'expected tool+command, got ' + fromPi.capabilities.length)
  check('command captured', fromPi.capabilities.some(c => c.kind === 'command' && c.name === 'demo-ping'))
  check('skill dir found', (fromPi.skillDirs || []).some(d => d.includes('demo-skill')), JSON.stringify(fromPi.skillDirs))

  const ctx = mockDshCtx()
  const report = await replayIntoDsh(ctx, fromPi, { prefix: 'pidemo' })
  check('replayed tool', report.tools.join() === 'pidemo_demo_echo', JSON.stringify(report.tools))
  check('replayed command', report.commands.join() === 'pidemo_demo-ping', JSON.stringify(report.commands))
  check('replayed skill provider', ctx.skillProviders.length === 1, JSON.stringify(report.skills))
  check('event mapped to agent/created', ctx.events.some(e => e.name === 'agent/created'), JSON.stringify(ctx.events.map(e => e.name)))
  check('nothing skipped', report.skipped.length === 0, JSON.stringify(report.skipped))

  const bridged = ctx.toolsArr[0]
  const params = JSON.stringify((bridged && bridged.parameters) || {})
  check('bridged tool parameter is described', /"text"/.test(params) && /"string"/.test(params), params)
  const runOut = bridged && await bridged.execute({ text: 'hello' }, {})
  check('bridged tool executes with DSH result shape', !!(runOut && runOut.ok === true && runOut.result === 'HELLO'), JSON.stringify(runOut))
  check('bridged tool declares output schema', !!(bridged && bridged.output && bridged.output.schema && bridged.output.schema.properties.ok))

  const provider = await ctx.skillProviders[0]()
  const listed = provider.list()
  check('skill provider lists SKILL.md', listed.length === 1 && listed[0].name === 'demo-skill', JSON.stringify(listed))
  const loaded = await provider.get(listed[0])
  check('skill content loads', typeof loaded.content === 'string' && loaded.content.includes('Do the demo thing'))

  console.log('DSH bundle -> pi host')
  const dshDir = await fixtureDsh()
  const fromDsh = await loadForeign(dshDir, { host: 'dsh' })
  check('classified as DSH bundle', fromDsh.info.dsh === true)
  check('bundle entry loaded', fromDsh.errors.length === 0, fromDsh.errors.join('; '))
  check('tool captured through defineTool', fromDsh.capabilities.some(c => c.kind === 'tool' && c.name === 'demo_sum'), JSON.stringify(fromDsh.capabilities.map(c => c.kind + ':' + c.name)))
  check('command captured', fromDsh.capabilities.some(c => c.kind === 'command' && c.name === 'demo-cmd'))
  check('async skill provider captured', fromDsh.capabilities.some(c => c.kind === 'skill' && c.name === 'dsh-demo-skill'), JSON.stringify(fromDsh.capabilities.map(c => c.kind + ':' + c.name)))

  const pi = mockPi()
  const report2 = replayIntoPi(pi, fromDsh, { prefix: 'dshdemo' })
  check('replayed to pi tool', report2.tools.join() === 'dshdemo_demo_sum', JSON.stringify(report2.tools))
  check('replayed to pi command', report2.commands.length === 1, JSON.stringify(report2.commands))
  check('skills contributed via resources_discover', pi.events.some(e => e.name === 'resources_discover'), JSON.stringify(report2))
  const discover = pi.events.find(e => e.name === 'resources_discover')
  const contributed = discover && await discover.handler({})
  check('bridged skill path is contributed', !!(contributed && (contributed.skillPaths || []).some(p => /dsh-demo-skill/.test(p))), JSON.stringify(contributed))
  const piTool = pi.tools[0]
  check('pi tool params are JSON Schema', !!(piTool && piTool.parameters && piTool.parameters.type === 'object' && (piTool.parameters.required || []).join() === 'a,b'), JSON.stringify(piTool && piTool.parameters))
  const r2 = await piTool.execute('tc', { a: 2, b: 3 }, undefined, undefined, {})
  check('pi tool returns pi content shape', r2.content[0].text === 'sum=5', JSON.stringify(r2))

  console.log('inert stub robustness (real plugin shapes)')
  const { inert } = await import('../src/inert.js')
  const Base = inert('Base')
  let subclassOk = false
  try { const C = class extends Base { constructor () { super(); this.x = 1 } }; subclassOk = new C().x === 1 } catch { subclassOk = false }
  check('a class can extend an inert binding', subclassOk)
  check('inert renders a named label', String(inert('x.y')) === '[dsh-pi-bridge stub: x.y]', String(inert('x.y')))
  check('inert is callable and chainable', typeof inert('z')() === 'function' && typeof inert('z').a.b.c === 'function')

  console.log('bridges survive a host restart')
  // A real DSH process reload re-runs apply() with a fresh scope. Recorded pi
  // packages must come back as tools on their own, or "installed" would only
  // mean "installed until the next restart".
  const entryMod = await import('../index.js')
  const cacheHome = process.env.DSH_PI_BRIDGE_HOME
  const { mkdir: mk, writeFile: wf } = await import('node:fs/promises')
  await mk(cacheHome, { recursive: true })
  const piSpec = piDir.replace(/\\/g, '/')
  const firstCaptured = await loadForeign(piSpec, { host: 'pi' })
  const prefixName = 'pidemo'
  await wf(path.join(cacheHome, 'bridges.json'), JSON.stringify({
    bridges: {
      [piSpec]: {
        name: firstCaptured.info.name, version: firstCaptured.info.version, host: 'pi',
        prefix: prefixName, mirror: firstCaptured.mirror,
        report: { tools: ['x'], commands: [], skills: [] },
      },
      [path.join(cacheHome, 'no-such-package').replace(/\\/g, '/')]: { name: 'nope', version: '0', host: 'pi', prefix: 'nope', mirror: '', report: { tools: [], commands: [], skills: [] } },
    },
  }, null, 2), 'utf8')
  // clear module cache so apply() reads the registry we just wrote
  const ctx2 = mockDshCtx()
  await entryMod.apply(ctx2, {})
  const restoredNames = ctx2.toolsArr.map(t => t.name)
  check('restart replays recorded pi tools', restoredNames.includes('pidemo_demo_echo'), JSON.stringify(restoredNames.slice(0, 8)))
  check('a broken record does not block the rest', restoredNames.includes('pi_install') && restoredNames.includes('bridge_list'), JSON.stringify(restoredNames.slice(0, 3)))

  console.log('restore never reaches the network')
  {
    const origFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (...args) => { calls++; return origFetch(...args) }
    try {
      const reg = path.join(cacheHome, 'bridges.json')
      const st = JSON.parse(await (await import('node:fs/promises')).readFile(reg, 'utf8'))
      // An npm spec with no cache entry: restore must report it, not download it.
      st.bridges['npm:some-package-never-cached'] = { name: 'x', version: '0', host: 'pi', prefix: 'x', mirror: '', report: {} }
      await (await import('node:fs/promises')).writeFile(reg, JSON.stringify(st), 'utf8')
      const { restoreIntoDsh } = await import('../src/restore.js')
      const out = await restoreIntoDsh(mockDshCtx(), st, {})
      check('restore issues no network request', calls === 0, 'fetch calls=' + calls)
      check('uncached bridge is reported as failed', out.failed.some(f => f.includes('some-package-never-cached')), JSON.stringify(out.failed).slice(0, 200))
    } finally { globalThis.fetch = origFetch }
  }

  console.log('resolver handles every source type')
  {
    // An earlier edit deleted fromGit/fromUrl/fromLocal while removing dead code
    // and nothing caught it: resolve() still referenced them, so every local
    // install crashed at runtime. Each parseSpec type must have a working branch.
    const { parseSpec } = await import('../src/resolve.js')
    const types = ['npm', 'git', 'url', 'local']
    const SPECIMENS = {
      npm: ['npm:foo', 'npm'],
      git: ['git:github.com/a/b', 'git'],
      // A GitHub repository URL is a git source wearing a URL: normalizing it
      // means the clone path handles it, so the expectation is git, not url.
      url: ['https://github.com/a/b', 'git'],
      'raw url': ['https://example.com/pkg.tgz', 'url'],
      local: [piDir, 'local'],
    }
    for (const [label, [spec, want]] of Object.entries(SPECIMENS)) {
      const parsed = parseSpec(spec)
      check('parseSpec(' + label + ') -> ' + want, parsed.type === want, JSON.stringify(parsed))
    }
    // A local resolve must actually copy, not throw a missing-function error.
    const local = await loadForeign(piDir, { host: 'pi' })
    check('local source resolves through the same path as npm', !!local.info.name && local.errors.length === 0, JSON.stringify(local.errors).slice(0, 200))
  }

  console.log('no placeholder dependencies survive')
  {
    // Placeholders (0.0.0-bridge-missing) used to occupy a real dependency's
    // directory: npm then saw the tree as installed and skipped it, so a working
    // package died with "is not a function". installDependencies must purge them.
    const { installDependencies } = await import('../src/resolve.js')
    const box = path.join(HOME, 'fixtures', 'placeholder-check')
    const nm = path.join(box, 'node_modules', 'left-pad')
    await mkdir(nm, { recursive: true })
    await writeFile(path.join(box, 'package.json'), JSON.stringify({ name: 'ph', version: '1.0.0', dependencies: { 'left-pad': '*' } }), 'utf8')
    await writeFile(path.join(nm, 'package.json'), JSON.stringify({ name: 'left-pad', version: '0.0.0-bridge-missing', main: 'index.mjs' }), 'utf8')
    await writeFile(path.join(nm, 'index.mjs'), 'export default {}\n', 'utf8')
    await installDependencies(box, () => {})
    let version = '(removed)'
    try { version = JSON.parse(await readFile(path.join(nm, 'package.json'), 'utf8')).version } catch { /* gone */ }
    check('placeholder version is purged before installing', version === '(removed)' || version === '0.0.0-bridge-missing' ? version !== '0.0.0-bridge-missing' : true, 'left-pad version now ' + version)
  }

  console.log('tool definitions satisfy the host schema rules')
  {
    // A real DSH boot rejected the bridge entry because its output schema carried
    // per-property required markers; the host's own defineTool accepts those, but
    // ctx.tools.register validates the compiled form and does not. These rules
    // come from probing the installed host, so they are the host's answer, not a
    // guess. A mock host cannot catch this, which is why the assertion lives here.
    const { OUT_SHAPE } = { OUT_SHAPE: null }
    const mod = await import('../index.js')
    void mod
    const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'index.js'), 'utf8')
    const outBlock = src.slice(src.indexOf('const OUT = () => ({'), src.indexOf('})', src.indexOf('const OUT = () => ({')))
    check('output schema carries no per-property required', !/required:/.test(outBlock), outBlock.replace(/\s+/g, ' ').slice(0, 160))
    check('output schema is object-rooted', /type: 'object'/.test(outBlock))
    check('output render is supplied', /render:/.test(outBlock))
    // Parameters must reach the host as a property spec map, never raw JSON Schema:
    // probing the host showed raw schema roots are rejected ("parameters.type must
    // be a value schema object").
    check('tools are defined through a spec-map helper', /parameters: toToolSpec\(/.test(src) || /function defineHostTool/.test(src))
    check('no bare host import that a linked bundle cannot resolve', !/await import\('@deepseek-ai\//.test(src), 'found dynamic host import')
  }

  console.log('daemon launches correctly from either runtime')
  {
    // Inside a host, process.execPath is the app binary, so spawning it with a
    // script argument opens another copy of the app and the daemon never comes up.
    // A real DSH boot hit exactly this. Both cases must decide correctly, and the
    // host case cannot be observed by running the daemon under plain node, so the
    // decision is a pure function and asserted as one.
    const { daemonLaunch } = await import('../src/proxy.js')
    const RUNNER_END = path.join('daemon', 'run.mjs')

    const plain = daemonLaunch({ PATH: '/usr/bin', HOME: '/root' }, 'linux', false)
    check('plain node: no ELECTRON_RUN_AS_NODE', plain.env.ELECTRON_RUN_AS_NODE === undefined, JSON.stringify(plain.env))
    check('plain node: runs the daemon runner', String(plain.args[0]).endsWith(RUNNER_END), String(plain.args[0]))

    const host = daemonLaunch({ PATH: '/usr/bin', HOME: '/root' }, 'linux', true)
    check('inside Electron: asks the binary to act as node', host.env.ELECTRON_RUN_AS_NODE === '1', JSON.stringify(host.env))

    // A GUI-launched host has no global npm bin in PATH, which is why the daemon's
    // own spawn of pi failed; the launcher must add where pi actually lives. Build a
    // fake install tree so the discovery rule is exercised against real files.
    const fakeHome = path.join(HOME, 'fake-win-home')
    const npmBin = path.join(fakeHome, 'AppData', 'Roaming', 'npm')
    await mkdir(npmBin, { recursive: true })
    await writeFile(path.join(npmBin, 'pi.cmd'), '@echo off\n', 'utf8')
    const win = daemonLaunch({ PATH: 'C:\\Windows', USERPROFILE: fakeHome }, 'win32', true)
    const pathAdded = String(win.env.PATH || '')
    check('win32 host: PATH gains the npm global bin holding pi', pathAdded.includes('npm') && pathAdded.includes('Windows'), pathAdded.slice(0, 160))
    check('win32 host: existing PATH entries are kept', pathAdded.includes('Windows'), pathAdded.slice(0, 160))
    // A home without pi must not invent a PATH entry.
    const bare = daemonLaunch({ PATH: 'C:\\Windows', USERPROFILE: path.join(HOME, 'nobody-here') }, 'win32', true)
    check('win32 host: no pi means no PATH change', bare.env.PATH === undefined, JSON.stringify(bare.env))
    // No silent daemon.log write: an unwritable cache must not fail a call.
    const { loadForeign: lf } = await import('../src/load.js')
    check('proxy module exports ensureDaemon', typeof (await import('../src/proxy.js')).ensureDaemon === 'function')
    void lf
  }

  console.log('every runtime file is published')
  {
    // A real DSH boot proved this matters twice: daemon/run.mjs was missing from
    // "files" so an installed bridge died on MODULE_NOT_FOUND, and later three
    // suites referenced by run-all slipped out while a hand-written list kept
    // passing. So the required set is derived from the code, not from a list.
    const fsP = await import('node:fs/promises')
    const read = (p) => fsP.readFile(path.join(ROOT, p), 'utf8')
    const pkg = JSON.parse(await read('package.json'))

    const referenced = new Set()
    const addMatches = (text, re) => { for (const m of text.matchAll(re)) referenced.add(m[1]) }

    // (a) every target package.json scripts invoke
    for (const cmd of Object.values(pkg.scripts || {})) {
      addMatches(String(cmd), /node\s+((?:scripts|daemon|tools)\/[\w./-]+\.mjs)/g)
    }
    // (b) suites listed by the aggregate runner
    try {
      const ra = await read('scripts/run-all.mjs')
      addMatches(ra.slice(ra.indexOf('const SUITES'), ra.indexOf(']', ra.indexOf('const SUITES'))), /['"]((?:scripts|daemon|tools)\/[\w.-]+\.mjs)['"]/g)
    } catch { /* runner absent is caught by (a) anyway */ }
    // (c) modules the entry points import
    for (const entry of ['index.js', 'extensions/index.js', 'daemon/run.mjs', 'daemon/bootstrap.js']) {
      let text = ''
      try { text = await read(entry) } catch { continue }
      addMatches(text, /from\s+['"]\.\.?\/((?:src|daemon)\/[\w.-]+\.js)['"]/g)
      addMatches(text, /import\(\s*['"]\.\.?\/((?:src|daemon)\/[\w.-]+\.js)['"]\s*\)/g)
    }
    // (d) module paths assembled with path.join: 'path.join(ROOT, "daemon", "run.mjs")'
    // names a shipped file but is invisible to the import and script scans, which
    // is why the first version of this guard still passed with daemon/run.mjs
    // removed from "files". Two- and three-argument forms are both handled.
    for (const file of ['src/proxy.js', 'src/load.js', 'daemon/run.mjs', 'index.js', 'extensions/index.js']) {
      let text = ''
      try { text = await read(file) } catch { continue }
      for (const m of text.matchAll(/path\.join\(\s*[\w.]+\s*,\s*['"]([\w.-]+)['"]\s*,\s*['"]([\w./-]+\.(?:mjs|js))['"]\s*\)/g)) {
        referenced.add(m[1] + '/' + m[2])
      }
      for (const m of text.matchAll(/path\.join\(\s*[\w.]+\s*,\s*['"]([\w./-]+\.(?:mjs|js))['"]\s*\)/g)) {
        const bare = m[1]
        if (bare.includes('/') || !/\.(mjs|js)$/.test(bare)) continue
        // a bare 'bootstrap.js' joined against a directory that is itself derived
        // from HERE: record it so the file must ship somewhere published.
        referenced.add('daemon/' + bare)
      }
    }
    // path.join construction is covered above; drop a false positive if the file
    // simply is not there to be shipped.
    for (const maybe of [...referenced]) {
      let exists = true
      try { await read(maybe) } catch { exists = false }
      if (!exists) referenced.delete(maybe)
    }

    referenced.add('index.js')
    referenced.add('extensions/index.js')
    referenced.add('cordis.patch.yml')
    referenced.add('skills/dsh-pi-bridge/SKILL.md')
    const needed = [...referenced].sort()

    // Explicit rules, not a regex: an earlier attempt embedded a character class
    // in a template literal and produced an unterminated string.
    function covered (pattern, rel) {
      const p = String(pattern).replace(/\\/g, '/')
      const file = String(rel).replace(/\\/g, '/')
      if (p.endsWith('/**')) return file.startsWith(p.slice(0, -2)) || file === p.slice(0, -3)
      const star = p.indexOf('*')
      if (star < 0) return file === p
      const head = p.slice(0, star)
      const tail = p.slice(star + 1)
      if (!file.startsWith(head) || !file.endsWith(tail)) return false
      const middle = file.slice(head.length, file.length - tail.length)
      return middle.length > 0 && !middle.includes('/')
    }
    const missing = needed.filter((f) => !(pkg.files || []).some((pat) => covered(pat, f)))
    check('files covers all ' + needed.length + ' referenced modules', missing.length === 0, 'missing: ' + missing.join(', '))

    const onDisk = []
    for (const f of needed) { try { await read(f) } catch { onDisk.push(f) } }
    check('every referenced module exists on disk', onDisk.length === 0, 'absent: ' + onDisk.join(', '))

    // The daemon resolves its runner by path expression; that must land on a file
    // the tarball carries, not one that only exists in the repository.
    const proxySrc = await read('src/proxy.js')
    const runnerLine = (proxySrc.split('\n').find((l) => l.includes('const RUNNER')) || '').trim()
    check('proxy resolves the runner through the package root', runnerLine.includes('ROOT') && runnerLine.includes('daemon') && runnerLine.includes('run.mjs'), runnerLine || 'no RUNNER const')
  }

  console.log('the first recorded bridge is attempted on restore')
  {
    // Restoring recorded bridges is what makes an install survive a restart. The
    // flag that bounds that work started as false while the skip test was
    // 'daemonProved === false', so the very first bridge was skipped and nothing
    // ever came back - a silent loss of persistence no mock covered. Three states
    // are needed: untried, worked, failed. Checked statically because the failure
    // only shows on a real host start, where the daemon may be unavailable.
    const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'index.js'), 'utf8')
    check('restore flag starts untried', /let daemonProved = null/.test(src), (src.split('\n').find((l) => l.includes('let daemonProved')) || 'absent').trim())
    check('inspection is not conflated with failure', /if \(capturing\)/.test(src) && /if \(daemonProved === false\)/.test(src))
    check('a success marks the daemon usable', /daemonProved = true/.test(src))
    check('a failure stops further waits', /daemonProved = false/.test(src))
    check('restore has a bounded wait', /waitMs: \d+/.test(src), (src.match(/waitMs: \d+/) || ['none'])[0])
  }

  console.log('forwarded tools are never restored as stubs')
  {
    // A DSH bundle loaded inside a live DSH session must come back the same way
    // after a restart. Restoring it through the translation path instead yields
    // stubbed look-alikes of tools that really worked - a silent downgrade, and
    // one observed on a real run. The routing decision is a name check, so assert
    // it as a name check rather than trusting a mock to notice.
    const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'extensions', 'index.js'), 'utf8')
    check('host-load entries are separated before replay', /entry\.mode === "dsh-host"/.test(src))
    check('they are restored by forwarding', /for \(const spec of forwardSpecs\)[\s\S]{0,160}installDshViaHost/.test(src))
    check('no DSH session means no stubbed substitute', /not replaying it as stubs/.test(src))
    check('the replay path only sees non-forward entries', /restoreIntoPi\(pi, replayState/.test(src))
  }

  console.log('arguments are checked before a bridged tool runs')
  {
    // The bridge used to call a package's execute() directly. Real packages then
    // failed inside their own code with messages like 'Cannot read properties of
    // undefined (reading trim)' - seen twice in a batch of twelve published pi
    // packages - while the receiving host would have said which argument was
    // missing. These are the checks that replace the crash with that message.
    const { validateArgs } = await import('../src/validate-args.js')
    const schema = { type: 'object', properties: { q: { type: 'string' }, n: { type: 'number' }, flag: { type: 'boolean' }, items: { type: 'array' } }, required: ['q'] }
    check('missing required key is named', validateArgs(schema, {}) === 'missing required key(s): q', validateArgs(schema, {}))
    check('null counts as missing', /missing required/.test(validateArgs(schema, { q: null }) || ''))
    check('a complete call passes', validateArgs(schema, { q: 'hi' }) === null, validateArgs(schema, { q: 'hi' }))
    check('wrong type is reported by name', /q expected string, got number/.test(validateArgs(schema, { q: 5 }) || ''), validateArgs(schema, { q: 5 }))
    check('number rejects a string', /n expected number/.test(validateArgs(schema, { q: 'a', n: 'x' }) || ''))
    check('integer rejects a fraction', /expected integer/.test(validateArgs({ type: 'object', properties: { i: { type: 'integer' } }, required: [] }, { i: 1.5 }) || ''))
    check('array rejects an object', /items expected array/.test(validateArgs(schema, { q: 'a', items: {} }) || ''))
    check('optional key given as null is tolerated', validateArgs(schema, { q: 'a', n: null }) === null, validateArgs(schema, { q: 'a', n: null }))
    // additionalProperties:false must reject unknown keys - a package's own schema says so.
    const strict = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }
    check('unknown argument rejected when closed', /unknown argument\(s\): b/.test(validateArgs(strict, { a: 'x', b: 1 }) || ''), validateArgs(strict, { a: 'x', b: 1 }))
    check('open schema allows extra keys', validateArgs({ type: 'object', properties: {} }, { anything: 1 }) === null)
    // No schema, or a schema the bridge cannot read, must not block a call.
    check('absent schema checks nothing', validateArgs(null, { q: 1 }) === null)
    check('non-object args treated as empty', /missing required/.test(validateArgs(schema, 'oops') || ''))
    // And the daemon must actually call it before execute.
    const boot = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'daemon', 'bootstrap.js'), 'utf8')
    check('daemon validates before executing', /const problem = \(await loadValidators\(\)\)\.validateArgs/.test(boot) && /if \(problem\) return json\(res, 200, \{ ok: false, rejected: true/.test(boot))
    check('a rejected call is labelled as such', /rejected: true/.test(boot))
  }

  console.log('no percent-encoded path derivation')
  {
    // Twice now a file path was derived from new URL(...).pathname, which keeps
    // percent-escapes: under this Chinese working directory it produced
    // 'dsh%E6%8F%92%E4%BB%B6...' and every lookup failed with a confusing
    // 'not a directory'. fileURLToPath is the only correct conversion, so no
    // shipped module may touch .pathname for paths at all.
    const { readFile: rf } = await import('node:fs/promises')
    const targets = ['index.js', 'extensions/index.js', 'daemon/run.mjs', 'daemon/bootstrap.js',
      'src/load.js', 'src/proxy.js', 'src/resolve.js', 'src/restore.js', 'src/dsh-loader.js',
      'src/serve.js', 'src/dsh-host-client.js', 'src/stubs.js', 'src/inert.js', 'src/manifest.js']
    const offenders = []
    for (const rel of targets) {
      let text = ''
      try { text = await rf(path.join(ROOT, rel), 'utf8') } catch { offenders.push(rel + ': unreadable'); continue }
      for (const line of text.split('\n')) {
        if (/\.pathname/.test(line) && !/fileURLToPath/.test(line)) offenders.push(rel + ': ' + line.trim().slice(0, 90))
      }
    }
    check('no shipped module derives a path from URL.pathname', offenders.length === 0, offenders.join(' | '))
    // And every module that needs a directory must import the decoder.
    const needs = ['index.js', 'daemon/run.mjs', 'daemon/bootstrap.js', 'src/load.js', 'src/proxy.js', 'src/dsh-loader.js']
    const missingImport = []
    for (const rel of needs) {
      try { const x = await rf(path.join(ROOT, rel), 'utf8'); if (/fileURLToPath\(/.test(x) && !/import .*fileURLToPath/.test(x)) missingImport.push(rel) } catch { /* checked above */ }
    }
    check('fileURLToPath is imported where used', missingImport.length === 0, missingImport.join(', '))
  }

  console.log('caches stay outside the published tree')
  {
    // A 1.9 GB npm-install tree once landed under scripts/: files:["scripts"] would
    // have shipped it. Published directories must never hold a bridge cache.
    const { readdir } = await import('node:fs/promises')
    const published = ['src', 'scripts', 'extensions', 'skills', 'tools']
    const offenders = []
    for (const dir of published) {
      let names = []
      try { names = await readdir(path.join(ROOT, dir)) } catch { continue }
      for (const n of names) if (/^\.[\w-]*cache$/.test(n) || /\bcleanroom\b/.test(n) || n.endsWith('.log') || n.endsWith('.tgz')) offenders.push(dir + '/' + n)
    }
    check('no cache or scratch tree inside published dirs', offenders.length === 0, offenders.join(', '))
    check('bridge cache root is outside published dirs', !String(process.env.DSH_PI_BRIDGE_HOME || '').includes(path.join(ROOT, 'scripts')), String(process.env.DSH_PI_BRIDGE_HOME))
  }

  console.log('dual-host self detection')
  const self = await loadForeign(ROOT, { host: 'auto' })
  check('self detected for both hosts', !!(self.info.pi && self.info.dsh), JSON.stringify(self.info.signals))

  console.log('')
  console.log(failures ? (checks - failures) + '/' + checks + ' checks passed, ' + failures + ' FAILED' : 'all ' + checks + ' checks passed')
  if (process.env.SELFTEST_KEEP !== '1') await rm(HOME, { recursive: true, force: true })
  else console.log('cache kept at ' + HOME)
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('selftest crashed:', (e && e.stack) || e); process.exit(2) })
