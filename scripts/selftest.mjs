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
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

  console.log('npm specs whose scope starts with a digit resolve')
  {
    // '@8kugames/dsh-zed-acp' used to be read as name '' + version
    // '8kugames/dsh-zed-acp': the /@\d/ check took '@8kugames' for a version and
    // the tail-strip regex then ate the whole scoped name, so the fetch landed on
    // the registry root and the install died as 'no tarball' although npm has one.
    const { resolve } = await import('../src/resolve.js')
    const { createServer } = await import('node:http')
    const tgzBytes = await readFile(path.join(HERE, 'fixtures', 'digit-scope', 'pkg.tgz'))
    const meta = {
      name: '@8kugames/dsh-zed-acp',
      'dist-tags': { latest: '0.3.5' },
      versions: {
        '0.3.5': { name: '@8kugames/dsh-zed-acp', version: '0.3.5', dist: { tarball: '/zed.tgz' } },
      },
    }
    const server = createServer((req, res) => {
      if (req.url === '/@8kugames%2Fdsh-zed-acp') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(meta))
      } else if (req.url === '/zed.tgz') {
        res.setHeader('content-type', 'application/x-tgz')
        res.end(tgzBytes)
      } else {
        res.statusCode = 404
        res.end('')
      }
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const base = 'http://127.0.0.1:' + server.address().port
    meta.versions['0.3.5'].dist.tarball = base + '/zed.tgz'
    const prev = process.env.DSH_PI_BRIDGE_REGISTRY
    process.env.DSH_PI_BRIDGE_REGISTRY = base
    try {
      const out = await resolve('npm:@8kugames/dsh-zed-acp', { refresh: true, log: () => {} })
      const manifest = JSON.parse(await readFile(path.join(out.dir, 'package.json'), 'utf8'))
      check('digit-scope npm package materializes from its latest tarball', manifest.version === '0.3.5', JSON.stringify(manifest))
    } finally {
      if (prev === undefined) delete process.env.DSH_PI_BRIDGE_REGISTRY
      else process.env.DSH_PI_BRIDGE_REGISTRY = prev
      server.close()
    }
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

  console.log('deferred registrations reach the report')
  {
    // A bundle registers from inside its own ctx.inject callback - the user's own
    // dsh-super-code and dsh-thinking-levels do - and the host hands that callback
    // a scope of its own, not the one this loader passed to apply(). Wrapping only
    // the apply() scope therefore missed every deferred tool: the host had it, the
    // bridge reported none, and the other side was told the bundle contributed
    // nothing. Both facts are asserted here: nothing is missed, and an unwrapped
    // callback would show up as a mismatch rather than a silent pass.
    const { loadDshBundle, rewriteBundleTree } = await import('../src/dsh-loader.js')
    const { cp } = await import('node:fs/promises')
    const cache = path.join(HOME, 'defer-cache')
    const bundle = path.join(cache, 'dsh-hostload')
    await mkdir(cache, { recursive: true })
    await cp(path.join(ROOT, 'scripts', 'fixtures', 'dsh-hostload'), bundle, { recursive: true })
    const hostFile = path.join(cache, 'defer-host.mjs')
    await writeFile(hostFile, 'export function defineTool(o) { return o }\n', 'utf8')

    const registered = []
    const ctx = {
      tools: { register: (t) => registered.push(t.name) },
      commands: { register: () => {} },
      skills: { registerProvider: () => {} },
      inject (names, fn) {
        // The host gives the callback a different scope object than apply() saw,
        // and that object is still a full scope - it carries inject itself, so a
        // bundle can nest. A mock missing it silently skips the deferred path.
        return fn({ tools: ctx.tools, commands: ctx.commands, skills: ctx.skills, llm: {}, inject: ctx.inject })
      },
    }
    const spec = (sp) => (sp === '@deepseek-ai/dsh-tools' ? hostFile.replace(/\\/g, '/') : null)
    const r = await loadDshBundle(bundle, ctx, { log: () => {}, resolveSpec: spec, cacheRoot: cache })
    check('the cache copy loads without a host', !r.error, r.error || '')
    // Compare sets, not a count: the number of tools in a fixture is not what this
    // rule is about, and hardcoding it broke the moment the fixture gained one.
    check('host registered the fixture tools', ['hl_hold', 'hl_echo', 'hl_deferred'].every((n) => registered.includes(n)), JSON.stringify(registered))
    const reported = (r.tools || []).map((t) => t.name)
    check('the report lists the deferred tool too', reported.includes('hl_deferred'), JSON.stringify(reported))
    check('nothing the host has is missing from the report',
      registered.filter((n) => !reported.includes(n)).length === 0,
      JSON.stringify(registered.filter((n) => !reported.includes(n))))
    const deferred = r.callable && r.callable.get('hl_deferred')
    check('the deferred tool is callable', !!deferred && typeof deferred.execute === 'function')
    // Commands registered from the deferred callback must appear too: two paths
    // disagreed on a live host run, and an empty list is not evidence of absence
    // when the registration was never looked for.
    const cmds = (r.commands || []).map((c) => c.name)
    check('the deferred command is reported', cmds.includes('hl-cmd-deferred'), JSON.stringify(cmds))
    if (deferred) {
      const out = await deferred.execute({ text: 'x' }, {})
      check('calling it runs the bundle code', out && out.result === 'DEFERRED-RAN:x', JSON.stringify(out))
    }

    // The in-place rewrite is confined to the bridge cache. A user pointing
    // dsh_install at their own source tree must not have that tree rewritten with
    // host-module URLs - that happened to a fixture here during development.
    const repoFile = path.join(ROOT, 'scripts', 'fixtures', 'dsh-hostload', 'index.js')
    const before = await readFile(repoFile, 'utf8')
    const refused = rewriteBundleTree(path.dirname(repoFile), spec, { cacheRoot: cache })
    check('a path outside the cache is refused', refused.refused === true && refused.files === 0, JSON.stringify(refused))
    const after = await readFile(repoFile, 'utf8')
    check('the refused source file is unchanged', before === after)
    check('rewriting inside the cache still works',
      rewriteBundleTree(bundle, spec, { cacheRoot: cache }).files > 0)
  }

  console.log('scoped dependencies are checked by name')
  {
    // 'How many top-level entries does node_modules have' is not evidence that the
    // declared dependencies are installed: two @scope/* packages occupy ONE
    // directory, so a package declaring both appeared half-installed yet "complete"
    // and the install was skipped - a live load then reported the second one
    // missing. Check names, and require a package.json that carries one.
    const { missingDependencies } = await import('../src/resolve.js')
    const root = path.join(HOME, 'fixtures', 'scoped-deps')
    const nm = path.join(root, 'node_modules')
    await mkdir(path.join(nm, '@acme', 'alpha'), { recursive: true })
    await writeFile(path.join(nm, '@acme', 'alpha', 'package.json'), JSON.stringify({ name: '@acme/alpha', version: '1.0.0' }))
    // One scoped package present, the other absent: entry counting saw "1 of 2",
    // close enough to pass, which is exactly the bug.
    const deps = ['@acme/alpha', '@acme/beta', 'plainpkg']
    const missing = await missingDependencies(nm, deps)
    check('scoped sibling reported missing', missing.includes('@acme/beta'), JSON.stringify(missing))
    check('installed scoped package not reported', !missing.includes('@acme/alpha'), JSON.stringify(missing))
    check('uninstalled plain package reported', missing.includes('plainpkg'), JSON.stringify(missing))
    // A directory without a package.json is not an installed package.
    await mkdir(path.join(nm, 'hollow'), { recursive: true })
    const m2 = await missingDependencies(nm, ['hollow'])
    check('a directory alone is not a dependency', m2.includes('hollow'), JSON.stringify(m2))
    // A package.json without a name is not one either.
    await mkdir(path.join(nm, 'noname'), { recursive: true })
    await writeFile(path.join(nm, 'noname', 'package.json'), '{"version":"1.0.0"}')
    const m3 = await missingDependencies(nm, ['noname'])
    check('an unnamed package.json is not a dependency', m3.includes('noname'), JSON.stringify(m3))
    // And a complete set reports nothing missing.
    await mkdir(path.join(nm, '@acme', 'beta'), { recursive: true })
    await writeFile(path.join(nm, '@acme', 'beta', 'package.json'), JSON.stringify({ name: '@acme/beta' }))
    await mkdir(path.join(nm, 'plainpkg'), { recursive: true })
    await writeFile(path.join(nm, 'plainpkg', 'package.json'), JSON.stringify({ name: 'plainpkg' }))
    const m4 = await missingDependencies(nm, ['@acme/alpha', '@acme/beta', 'plainpkg'])
    check('a full set reports nothing missing', m4.length === 0, JSON.stringify(m4))
    // The install decision must consult names, not entry counts.
    const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'src', 'resolve.js'), 'utf8')
    check('install decision uses names', /const missing = await missingDependencies\(nm, deps\)/.test(src))
    // Reassigned because a retry may clear the list, so the declaration keyword
    // varies; what the rule requires is that the decision reads names.
    check('post-install recheck uses names', /stillMissing = await missingDependencies\(nm, deps\)/.test(src))
    check('no entry-count shortcut left', !/present >= deps.length/.test(src))
  }

  console.log('peers beyond the manifest join the ship list')
  {
    // The main install skips every peer (--legacy-peer-deps), including the
    // ones an installed dependency itself declares: @8kugames/dsh-zed-acp died
    // on "Cannot find package 'zod'" although @agentclientprotocol/sdk - zod's
    // declarer - sat in node_modules. peersToShip reads the tree's manifests.
    const nm = path.join(HOME, 'fixtures', 'nested-peers', 'node_modules')
    await mkdir(path.join(nm, 'sdk'), { recursive: true })
    await mkdir(path.join(nm, 'kit'), { recursive: true })
    await mkdir(path.join(nm, 'present'), { recursive: true })
    await mkdir(path.join(nm, '@deepseek-ai', 'cordis'), { recursive: true })
    await writeFile(path.join(nm, 'sdk', 'package.json'), JSON.stringify({ name: 'sdk', version: '1.2.3', peerDependencies: { zod: '^3.0.0', kit: '*' } }))
    await writeFile(path.join(nm, 'kit', 'package.json'), JSON.stringify({ name: 'kit', version: '0.9.0', peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } }))
    await writeFile(path.join(nm, 'present', 'package.json'), JSON.stringify({ name: 'present', version: '0.0.1', peerDependencies: { zod: '^3.0.0' } }))
    const { peersToShip } = await import('../src/resolve.js')
    const isHost = (n) => (String(n).startsWith('@deepseek-ai/') ? { name: n } : null)
    let ship = await peersToShip(nm, [], isHost)
    check('a nested peer of an installed package joins', ship.map(([n]) => n).join() === 'zod', JSON.stringify(ship))
    check('an installed peer is not re-provisioned', !ship.some(([n]) => n === 'kit'), JSON.stringify(ship))
    check('a host-resolved peer stays out', !ship.some(([n]) => String(n).startsWith('@deepseek-ai/')), JSON.stringify(ship))
    // Provisioning is for absentees: once zod lands, nothing remains.
    await mkdir(path.join(nm, 'zod'), { recursive: true })
    await writeFile(path.join(nm, 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '3.23.8' }))
    ship = await peersToShip(nm, [], isHost)
    check('a complete tree ships nothing', ship.length === 0, JSON.stringify(ship))
  }

  console.log('a split bundle resolves its own name')
  {
    // dsh-mnemon's providers each \`import "dsh-mnemon"\`. Installed by the plugin
    // manager they sit beside the parent so Node walks up and finds it; in the
    // bridge cache they do not, and the load died on the first provider. The fix
    // writes a forwarding package, and forwarding is easy to get wrong: './..'
    // targets throw ERR_INVALID_PACKAGE_TARGET, a missing directory throws ENOENT,
    // and an unimported helper throws ReferenceError at the caller - all three
    // happened here and none of them were visible without resolving for real.
    const root = path.join(HOME, 'fixtures', 'selfref')
    await mkdir(path.join(root, 'node_modules', 'provider-a'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'my-bundle', version: '2.0.0', type: 'module', main: './lib/index.js',
      exports: { '.': { import: './lib/index.js' }, './core': { import: './lib/core.js' } },
    }, null, 2))
    await mkdir(path.join(root, 'lib'), { recursive: true })
    await writeFile(path.join(root, 'lib', 'index.js'), 'export const marker = "PARENT"\n', 'utf8')
    await writeFile(path.join(root, 'lib', 'core.js'), 'export const core = "CORE"\n', 'utf8')
    await writeFile(path.join(root, 'node_modules', 'provider-a', 'package.json'), JSON.stringify({
      name: 'provider-a', version: '1.0.0', type: 'module', main: './index.js', dependencies: { 'my-bundle': '^2.0.0' },
    }, null, 2))
    // 让 provider-a 视为"已安装"，走离线路径（不联网）
    await mkdir(path.join(root, 'node_modules', 'my-bundle'), { recursive: true }).catch(() => {})
    await writeFile(path.join(root, 'node_modules', 'provider-a', 'index.js'), 'import { marker } from "my-bundle"\nexport const seen = marker\n', 'utf8')

    const { installDependencies } = await import('../src/resolve.js')
    const notes = []
    const deps = await installDependencies(root, (m) => notes.push(String(m)))
    check('self-reference reported', notes.some((n) => /self-reference/.test(n)), notes.join(' | '))
    const shimFile = path.join(root, 'node_modules', 'my-bundle', 'package.json')
    let shim = null
    try { shim = JSON.parse(await readFile(shimFile, 'utf8')) } catch (e) { check('forwarding package written', false, String(e.code)) }
    if (shim) {
      check('forwarding package keeps the name', shim.name === 'my-bundle', JSON.stringify(shim).slice(0, 120))
      check('targets do not climb out with "./.."', !JSON.stringify(shim).includes('"./..'), JSON.stringify(shim.exports || shim.main))
      const { createRequire } = await import('node:module')
      const req = createRequire(path.join(root, 'node_modules', 'provider-a', 'index.js'))
      let resolved = ''
      try { resolved = req.resolve('my-bundle') } catch (e) { check('provider resolves the parent by name', false, e.code + ' ' + String(e.message).slice(0, 90)) }
      if (resolved) {
        // Landing on the forwarding file is the design, not a failure: it climbs
        // to the parent with a relative import that "exports" would forbid. What
        // matters is that importing through it yields the parent's own value - one
        // module instance, not a copy.
        check('resolution lands on the forwarding package', resolved.includes(path.join('node_modules', 'my-bundle')), resolved)
        const mod = await import(pathToFileURL(resolved).href)
        check('importing the parent name yields the parent value', mod.marker === 'PARENT', JSON.stringify(Object.keys(mod)))
        let sub = ''
        try { sub = req.resolve('my-bundle/core') } catch (e) { check('subpath export resolves', false, e.code) }
        if (sub) {
          const subMod = await import(pathToFileURL(sub).href)
          check('subpath yields the parent core value', subMod.core === 'CORE', JSON.stringify(Object.keys(subMod)))
        }
        // The provider itself must import cleanly through the forwarder.
        const viaProvider = await import(pathToFileURL(path.join(root, 'node_modules', 'provider-a', 'index.js')).href)
        check('a dependent package imports the parent by name', viaProvider.seen === 'PARENT', JSON.stringify(viaProvider))
    }
  }
  }

  console.log('a renamed host module still resolves for a package')
  {
    // pi publishes typebox, but packages keep importing the old
    // '@sinclair/typebox' name - @ff-labs/pi-fff did, on a real run, and failed
    // with 'Cannot find module @sinclair/typebox' while typebox sat in the same
    // node_modules. pi's own alias table maps both names, so mirroring it has to
    // map both as well.
    const { buildAliasTable } = await import('../src/pi-aliases.js')
    const piDir = process.env.DSH_PI_BRIDGE_TEST_PI_DIR
    if (!piDir) {
      check('legacy alias test skipped without a pi install', true)
    } else {
      const t = buildAliasTable(piDir)
      check('no alias gaps against the real pi install', t.missing.length === 0, JSON.stringify(t.missing))
      check('the old @sinclair name resolves to the real typebox', !!t.alias['@sinclair/typebox'], JSON.stringify(Object.keys(t.alias).slice(0, 5)))
      const sameFile = (a, b) => String(a).split(/[\\/]/).slice(-3).join('/') === String(b).split(/[\\/]/).slice(-3).join('/')
      check('legacy and current names reach the same module',
        !!t.alias['@sinclair/typebox'] && !!t.alias.typebox && sameFile(t.alias['@sinclair/typebox'], t.alias.typebox),
        JSON.stringify([t.alias['@sinclair/typebox'], t.alias.typebox]))
      check('legacy subpath exports map too', !!t.alias['@sinclair/typebox/value'] && !!t.alias['@sinclair/typebox/compile'],
        JSON.stringify(Object.keys(t.alias).filter((k) => k.startsWith('@sinclair'))))
    }
  }

  console.log('a load error belongs to its own package')
  {
    // One shared error array made the first package's failure appear in every
    // later report: '@sinclair/typebox' was blamed on three packages that had
    // loaded fine, which would have sent me debugging the wrong one. The reply to
    // a load must carry only what that load produced.
    const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'daemon', 'bootstrap.js'), 'utf8')
    check('loadPackage takes a per-call error sink', /async function loadPackage \(root, pi, sink, noteSink\)/.test(src))
    check('the /load reply uses its own array', /errors: pkgErrors/.test(src))
    check('the /load reply no longer slices a global array', !/errors: loadErrors\.slice/.test(src))
    check('notes are scoped the same way', /notes: pkgNotes\.slice/.test(src) && !/notes\.filter\(\(n\) => n\.includes\(owner\)\)/.test(src))
    check('startup loads still record globally', /for \(const root of PACKAGES\) await loadPackage\(root, pi\)/.test(src))
    // Health has to keep exposing loader failures, or scoping them would hide them
    // entirely from bridge_status.
    const health = src.slice(src.indexOf("if (url === '/health')"), src.indexOf("if (url === '/health')") + 400)
    check('health still reports load errors', /loadErrors/.test(health), health.replace(/\s+/g, ' ').slice(0, 200))
    // The exact invariant a textual check missed: the sinks are const bindings,
    // so declaring them below the call that passes them threw "Cannot access
    // 'pkgErrors' before initialization" and made EVERY /load fail - while the
    // checks above, which only looked for the names, stayed green. Order, not
    // presence, is what matters here.
    const loadBranch = src.slice(src.indexOf("if (url === '/load')"), src.indexOf("if (url === '/call')"))
    const declPos = loadBranch.indexOf('const pkgErrors = []')
    const usePos = loadBranch.indexOf('await loadPackage(root, pi, pkgErrors')
    check('declared before the load that uses them', declPos >= 0 && usePos >= 0 && declPos < usePos,
      'decl=' + declPos + ' use=' + usePos)
    check('no second declaration of the sinks', (loadBranch.match(/const pkgErrors = \[\]/g) || []).length === 1)
  }

  console.log('an install failure names npm reason')
  {
    // pi-harness-runtime failed with 'npm exited 1' and nothing else, which sent
    // me guessing at timeouts and registry problems for two rounds. npm's own
    // output said 'Unsupported URL Type "workspace:"' - the published package
    // ships six sub-packages whose manifests use the workspace protocol, which
    // cannot resolve outside a workspace. The cause was in npm's terminal the
    // whole time; stdio: 'ignore' threw it away.
    const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'src', 'resolve.js'), 'utf8')
    const spawnLines = src.split('\n').filter((l) => /spawn\(/.test(l))
    const discarding = spawnLines.filter((l) => l.includes("stdio: 'ignore'"))
    check('no spawn discards output entirely', discarding.length === 0, discarding.join(' || ').slice(0, 200))
    check('npm output is captured', /child\.stderr\.on\('data', keep\)/.test(src))
    check('the failure reason appends what npm said', /npm said: /.test(src))
    check('a killed install says so with its budget', /killed after /.test(src) && /INSTALL_BUDGET_MS/.test(src))
    check('the budget is adjustable without a rebuild', /DSH_PI_BRIDGE_INSTALL_MS/.test(src))
    check('no reason is built from the exit code alone',
      !/reason: 'npm exited ' \+ code \}/.test(src) && !/reason: 'npm exited ' \+ code,$/.test(src))
    // The peer gate must stay keyed on 'the build cannot resolve this peer': a
    // family filter left it blind to everything else the manifest declares -
    // dsh-custom-provider's @earendil-works/pi-ai and dsh-gap-feed's react both
    // died MODULE_NOT_FOUND although npm resolves both.
    check('the peer gate covers every peer the build cannot resolve',
      /typeof r === 'string' && !hostEntry\(n\)/.test(src) && !/isHostSpecifier\(n\)/.test(src),
      'filter still keyed on a family specifier')
    // npm 11.16 answers every named CLI add with "up to date" when the manifest
    // carries devDependencies and the run passes --omit=dev (measured on the
    // gap-feed copy and a two-line fixture: peers died missing although npm
    // exited 0). The cache copy sheds the field before npm runs; losing the
    // strip brings the silent failure back.
    check('the cache copy sheds the devDependencies npm 11.16 exploits',
      /delete pkg\.devDependencies/.test(src) && /npm 11\.16/.test(src))
    // Peers one level past the manifest: @agentclientprotocol/sdk (installed,
    // hoisted top-level) peers on zod, and the main install skips peer
    // auto-install entirely - only the scan can name it.
    check('the peers pass provisions peers of the installed tree too',
      /await peersToShip\(nm, peerEntries, hostEntry\)/.test(src) && /export async function peersToShip/.test(src))
    // Plain arborist resolution refuses legitimate peers when the dsh rc
    // channels conflict (custom-provider's pi-ai); one legacy retry fixes that
    // without handing every install to the flag.
    check('a failed peers pass retries with --legacy-peer-deps',
      /provisioning the peers with --legacy-peer-deps/.test(src) && /'--legacy-peer-deps', \.\.\.specs\]/.test(src))
  }

  console.log('a declared entry that is missing is reported')
  {
    // agent-comms declares pi.extensions './src/bridges/pi/extension.ts' and ships
    // dist/bridges/pi/extension.js. The published tarball simply does not contain
    // what its own manifest points at (pi's own loader fails on it too), and the
    // bridge reported only 'nothing callable arrived' - which reads like a package
    // without tools, so the user would never learn the pointer is broken.
    const { piEntries, readJson } = await import('../src/manifest.js')
    const root = path.join(HOME, 'fixtures', 'missing-entry')
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'missing-entry', version: '1.0.0', type: 'module',
      pi: { extensions: ['./src/gone.ts'] },
    }, null, 2), 'utf8')
    await writeFile(path.join(root, 'dist', 'real.js'), 'export default function () {}\n', 'utf8')
    const pkg = await readJson(path.join(root, 'package.json'))
    const found = await piEntries(root, pkg)
    // The silent drop is the root behaviour being worked around; assert it so the
    // reporting code cannot be "fixed" by someone who assumes piEntries keeps it.
    check('a missing declared entry resolves to nothing', (found.extensions || []).length === 0, JSON.stringify(found.extensions))
    const boot = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'daemon', 'bootstrap.js'), 'utf8')
    check('the bridge names the missing declared entry', /declared entry not in package/.test(boot))
    check('it reads the package own declaration, not the filtered list',
      /declared = \(\(pkg\.pi && pkg\.pi\.extensions\) \|\| \[\]\)/.test(boot))
  }

  console.log('a stale daemon is replaced and a failed load is raised')
  {
    // Two ways this bridge lied by omission. A daemon that outlives an upgrade
    // answers health with the OLD code loaded, so a verification run measures the
    // previous build - that is exactly what happened here, where a batch reported
    // 'nothing callable' for packages a direct daemon query had just loaded fine.
    // And loadIntoPi read only the plural errors array, so a refusal (reported as
    // { ok: false, error }) surfaced as a successful load with zero tools.
    const { isStaleDaemon } = await import('../src/proxy.js')
    const { buildFingerprint } = await import('../src/build-id.js')
    // Behaviour, not text: a version string cannot detect a code change (it stays
    // put while the code is edited under it), so the daemon stamps a digest of the
    // modules it runs. Two fixtures with different bytes prove the digest is
    // sensitive to an edit, which is the whole point - and that a check which only
    // looked for the identifier 'BRIDGE_VERSION' could never show.
    const here = buildFingerprint(ROOT)
    check('the bridge fingerprints its own code', typeof here === 'string' && here.length === 12, String(here))
    check('a matching stamp is fresh', isStaleDaemon({ ok: true, bridgeVersion: here }) === false)
    check('a mismatched stamp is stale', isStaleDaemon({ ok: true, bridgeVersion: 'older1234567' }) === true)
    check('an unstampéd daemon is treated as stale', isStaleDaemon({ ok: true }) === true, 'bridgeVersion undefined')
    check('a dead daemon is not called stale', isStaleDaemon({ ok: false }) === false)
    check('a missing code root yields no digest', buildFingerprint(path.join(HOME, 'no-such-root')) === null)
    const fixed = path.join(HOME, 'fixtures', 'digest')
    await mkdir(path.join(fixed, 'a'), { recursive: true })
    await mkdir(path.join(fixed, 'b'), { recursive: true })
    await mkdir(path.join(fixed, 'c'), { recursive: true })
    await writeFile(path.join(fixed, 'a', 'index.js'), 'export const v = 1', 'utf8')
    await writeFile(path.join(fixed, 'b', 'index.js'), 'export const v = 2', 'utf8')
    await writeFile(path.join(fixed, 'c', 'index.js'), 'export const v = 1', 'utf8')
    const da = buildFingerprint(path.join(fixed, 'a'))
    const db = buildFingerprint(path.join(fixed, 'b'))
    const dc = buildFingerprint(path.join(fixed, 'c'))
    check('an edit changes the digest', !!da && !!db && da !== db, da + ' vs ' + db)
    check('identical code digests the same', dc === da, dc + ' vs ' + da)
    check('the daemon stamps health with the digest', await (async () => {
      const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'daemon', 'run.mjs'), 'utf8')
      return src.includes('out.bridgeVersion = BRIDGE_VERSION')
        && src.includes('BRIDGE_VERSION = buildFingerprint(') && src.includes("from '../src/build-id.js'")
    })())
    check('loadIntoPi raises a refusal', await (async () => {
      const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'src', 'proxy.js'), 'utf8')
      return /reply\.ok === false && reply\.error/.test(src) && src.includes('pi could not load the package')
    })())
    // The plural array must still be reported, or per-file problems go silent.
    check('per-file errors still surface in the report', await (async () => {
      const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'index.js'), 'utf8')
      return /loaded\.errors && loaded\.errors\.length/.test(src)
    })())
  }

  console.log('a stale DSH session aborts the measurement')
  {
    // The mirror-image of the daemon check, and it had to be learned the hard
    // way twice: a batch of ten published bundles reported 0 loads and the
    // session was running the copy synced before the fixes, so the result
    // described a process that no longer existed. The guard turns that into a
    // loud abort instead of a fake measurement.
    const { staleSession } = await import('../src/dsh-host-client.js')
    const { buildFingerprint } = await import('../src/build-id.js')
    const here = buildFingerprint(ROOT)
    check('an unstamped session is refused', /predates this build/.test(String(staleSession({ ok: true, serve: true, pid: 1 }))), String(staleSession({ ok: true, serve: true, pid: 1 })))
    check('a mismatched session is refused', /but this is/.test(String(staleSession({ ok: true, serve: true, bridgeVersion: 'deadbeef0000' }))))
    check('a matching session is accepted', staleSession({ ok: true, serve: true, bridgeVersion: here }) === null)
    check('a session that is not serving is not called stale', staleSession({ ok: true, serve: false }) === null)
    const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'package.json'), 'utf8'))
    check('serve stamps health with the digest', await (async () => {
      const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'src', 'serve.js'), 'utf8')
      return src.includes('bridgeVersion: BRIDGE_VERSION') && src.includes('BRIDGE_VERSION = buildFingerprint(')
    })(), pkg.version)
    // Both batch harnesses must refuse rather than record a stale run.
    for (const tool of ['batch-pi-side.mjs', 'batch-dsh-to-pi.mjs']) {
      const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'tools', tool), 'utf8')
      check(tool + ' aborts on a stale session', src.includes('staleSession(health)') && /ABORT \(stale session/.test(src))
    }
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

  console.log('pi runtime resolution: the machine with only one side installed')
  {
    const { resolvePi, findPiModuleDir, piFailureMessage } = await import('../src/pi-launch.js')
    const win = 'win32'
    const home = path.join(HOME, 'fake-home')
    const pkgDir = path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent')
    const cli = path.join(pkgDir, 'dist', 'bundle', 'cli.js')
    const manifest = JSON.stringify({ version: '1.4.0', bin: { pi: 'dist/bundle/cli.js' } })
    // A described filesystem, so "no pi at all" is a case a test can state rather
    // than a machine someone has to build.
    const vfs = (fileMap) => ({
      exists: (p) => Object.prototype.hasOwnProperty.call(fileMap, p),
      read: (p) => { if (!(p in fileMap)) throw new Error('ENOENT'); return fileMap[p] },
    })

    const full = resolvePi({ env: { PATH: '' }, platform: win, home, ...vfs({ [path.join(pkgDir, 'package.json')]: manifest, [cli]: '' }) })
    check('an installed package resolves to its own bin entry', full.ok && full.source === 'package' && full.version === '1.4.0' && full.args[0] === cli, JSON.stringify(full))
    check('the package form runs under this node, not a shell shim', full.ok && full.command === process.execPath)

    const piCmd = path.join(home, 'AppData', 'Roaming', 'npm', 'pi.cmd')
    const onPath = resolvePi({ env: { PATH: path.dirname(piCmd) }, platform: win, home, ...vfs({ [piCmd]: '' }) })
    check('a pi on PATH is used as found', onPath.ok && onPath.source === 'path' && onPath.command === piCmd, JSON.stringify(onPath))

    const override = resolvePi({ env: { PATH: '', DSH_PI_BRIDGE_PI: path.join(HOME, 'opt', 'cli.js') }, platform: 'linux', home, ...vfs({ [path.join(HOME, 'opt', 'cli.js')]: '' }) })
    check('an explicit DSH_PI_BRIDGE_PI wins over discovery', override.ok && override.source === 'override' && override.command === process.execPath, JSON.stringify(override))

    const missingOverride = resolvePi({ env: { PATH: '', DSH_PI_BRIDGE_PI: '/definitely/not/here/cli.js' }, platform: 'linux', home, ...vfs({}) })
    check('a missing override is reported, not silently skipped', !missingOverride.ok && missingOverride.searched.some((s) => s.includes('/definitely/not/here')), JSON.stringify(missingOverride.searched))

    const noPi = resolvePi({ env: { PATH: '' }, platform: win, home, ...vfs({}) })
    const message = noPi.ok ? '' : piFailureMessage(noPi)
    check('a machine with no pi refuses instead of guessing', noPi.ok === false && /no pi runtime/.test(noPi.reason))
    check('the refusal lists what was looked in', noPi.ok === false && noPi.searched.length >= 2, JSON.stringify(noPi.searched))
    check('the refusal carries the install command', /npm install -g @earendil-works\/pi-coding-agent/.test(message), message.slice(0, 120))

    // The two questions must stay separate: a package whose bin is missing still
    // supplies the modules jiti aliases, but it cannot be run.
    const noBin = vfs({ [path.join(pkgDir, 'package.json')]: manifest })
    check('a package without its bin still yields a module dir', findPiModuleDir({ env: { PATH: '' }, platform: win, home, ...noBin }) === pkgDir)
    check('but it is not a runnable pi', resolvePi({ env: { PATH: '' }, platform: win, home, ...noBin }).ok === false)
  }

  console.log('a daemon that cannot start says why, in seconds')
  {
    const { spawn: spawnProc } = await import('node:child_process')
    const { request: httpRequest } = await import('node:http')
    const port = 45000 + Math.floor(Math.random() * 400)
    const isolated = path.join(HOME, 'no-pi-home')
    await mkdir(isolated, { recursive: true })
    const proc = spawnProc(process.execPath, [path.join(ROOT, 'daemon', 'run.mjs'), '--port', String(port), '--journal', path.join(HOME, 'no-pi-journal.txt')], {
      env: { ...process.env, PATH: '', Path: '', USERPROFILE: isolated, HOME: isolated, PI_MODULE_DIR: '', DSH_PI_BRIDGE_PI: '' },
      stdio: 'ignore', windowsHide: true,
    })
    const get = (route, ms) => new Promise((res, rej) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: route, method: 'GET', agent: false, timeout: ms }, (r) => {
        let raw = ''
        r.on('data', (c) => { raw += c })
        r.on('end', () => { try { res(JSON.parse(raw)) } catch (e) { rej(e) } })
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', rej)
      req.end()
    })
    const started = Date.now()
    let h = null
    for (let i = 0; i < 24 && !h; i++) {
      await new Promise((r) => setTimeout(r, 250))
      try { h = await get('/health', 800) } catch { /* not listening yet */ }
    }
    const elapsed = Date.now() - started
    check('health answers with a terminal reason', !!(h && h.terminal && /needs a pi runtime/.test(h.reason)), JSON.stringify(h).slice(0, 240))
    check('it answers in seconds, not the 45s budget', elapsed < 5000, elapsed + 'ms')
    check('the reason is the actionable message, not a symptom', !!(h && /npm install -g/.test(h.reason)), String(h && h.reason).slice(0, 160))
    try { proc.kill() } catch { /* already gone */ }
  }

  console.log('')
  console.log(failures ? (checks - failures) + '/' + checks + ' checks passed, ' + failures + ' FAILED' : 'all ' + checks + ' checks passed')
  if (process.env.SELFTEST_KEEP !== '1') await rm(HOME, { recursive: true, force: true })
  else console.log('cache kept at ' + HOME)
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('selftest crashed:', (e && e.stack) || e); process.exit(2) })
