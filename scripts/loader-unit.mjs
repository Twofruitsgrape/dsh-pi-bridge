// Unit checks for the runtime DSH bundle loader: specifier classification and
// host rewriting. They need no host, so they can gate the publish path.
import { isHostSpecifier, rewriteHostSpecifiers, rewriteBundleTree, hostModulesRoots } from "../src/dsh-loader.js"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"

let fails = 0
const check = (label, ok, detail) => {
  if (ok) console.log("  ok   " + label)
  else { fails++; console.log("  FAIL " + label + (detail ? " :: " + detail : "")) }
}

check("classifies @deepseek-ai/* as host", isHostSpecifier("@deepseek-ai/dsh-tools"))
check("classifies cordis as host", isHostSpecifier("cordis"))
check("classifies @deepseek-ai/schemastery as host", isHostSpecifier("@deepseek-ai/schemastery"))
check("leaves a third-party package alone", !isHostSpecifier("picocolors"))
check("leaves node: alone", !isHostSpecifier("node:fs"))
check("leaves relative alone", !isHostSpecifier("./x.js"))

const SRC = [
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  "import { z } from '@deepseek-ai/schemastery'",
  "import rel from './rel.js'",
  "import fs from 'node:fs'",
  "import pc from 'picocolors'",
  "const lazy = () => import('@deepseek-ai/dsh-llm')",
].join(String.fromCharCode(10))

const fake = (s) => (s === "@deepseek-ai/dsh-tools" || s === "@deepseek-ai/dsh-llm" ? "C:/host/mod.js" : null)
const { code, mapped } = rewriteHostSpecifiers(SRC, fake)

check("rewrote the resolvable host import", code.includes("file:///C:/host/mod.js"), code.slice(0, 140))
check("reported what it mapped", mapped.length === 2 && mapped[0].specifier === "@deepseek-ai/dsh-tools", JSON.stringify(mapped))
check("left the unresolvable host import alone", code.includes("'@deepseek-ai/schemastery'"), code.slice(0, 200))
check("kept the relative specifier", code.includes("'./rel.js'"))
check("kept the node: specifier", code.includes("'node:fs'"))
check("kept the third-party specifier", code.includes("'picocolors'"))
const hits = code.split("file:///C:/host/mod.js").length - 1
check("rewrote the dynamic import as well", hits === 2, "hits=" + hits + " tail=" + code.slice(-90))

// A specifier can also arrive as a bare side-effect import with no "from" at all.
// The rewriter matched only "from x" and "import(x)", so a bundle whose hooks.js
// opened with import '@deepseek-ai/dsh-session'; kept the bare name and node
// could not resolve it from the cache copy. My report then blamed the package for
// wanting a module the installed build does contain - measured with
// @furongjun1999/dsh-memory, whose specifier resolves fine from the build
// node_modules. Assert every shape a specifier arrives in, and that a named
// import is not rewritten twice.
const SPEC = "@deepseek-ai/dsh-session"
const fakeSpec = (x) => (x === SPEC ? "C:/host/node_modules/dsh-session/lib/index.js" : null)
const shapes = [
  ["import " + JSON.stringify(SPEC) + ";", "bare side-effect import"],
  ["import(" + JSON.stringify(SPEC) + ")", "dynamic import"],
  ["import { x } from " + JSON.stringify(SPEC), "named import"],
  ["export * from " + JSON.stringify(SPEC), "re-export"],
]
for (const [src, label] of shapes) {
  const out = rewriteHostSpecifiers(src, fakeSpec)
  check(label + " rewritten", out.mapped.length === 1 && out.code.includes("file:///C:/host"),
    label + " -> " + out.code.slice(0, 90) + " mapped=" + out.mapped.length)
}
const once = rewriteHostSpecifiers("import { x } from " + JSON.stringify(SPEC), fakeSpec)
check("a named import is rewritten exactly once",
  once.code.split("file:///C:/host").length - 1 === 1 && once.mapped.length === 1, once.code)
const left = rewriteHostSpecifiers("import " + JSON.stringify("./local.js"), fakeSpec)
check("a relative side-effect import is untouched", left.mapped.length === 0 && left.code.includes("./local.js"), left.code)

// A peer dependency is a third-party specifier the bundle tree usually does not
// carry: the cache install skips peers (--legacy-peer-deps; in a native install
// they are the host's job). Measured live: npm:dsh-mcp-connector declares zod as
// a peer, a cache copy died with "Cannot find package 'zod'", and the running
// build ships a genuine zod - so a third-party import must resolve from the
// bundle's own tree first, then the running build, and a true absence must stay
// untouched so the load reports the real MODULE_NOT_FOUND instead of a stub.
{
  const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const PRISTINE = "import { x } from '@deepseek-ai/dsh-tools'\nimport { z } from 'zod'\nexport const both = [x, z]\n"
  const absentDir = path.join(FIX, 'peer-absent')
  const localDir = path.join(FIX, 'peer-local')
  const servesBoth = (s) => (s === '@deepseek-ai/dsh-tools' ? 'C:/host/tools.js' : s === 'zod' ? 'C:/host/zod-entry.js' : null)
  // rewriteBundleTree rewrites files in place: every run starts from the pristine
  // imports instead of measuring the previous run's file: URLs, and ends by
  // restoring what it touched.
  writeFileSync(path.join(absentDir, 'index.js'), PRISTINE)
  writeFileSync(path.join(localDir, 'index.js'), PRISTINE)
  mkdirSync(path.join(localDir, 'node_modules', 'zod'), { recursive: true })
  writeFileSync(path.join(localDir, 'node_modules', 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '4.0.0', main: 'index.js' }))
  writeFileSync(path.join(localDir, 'node_modules', 'zod', 'index.js'), 'export const z = { shape: true }\n')
  const a = rewriteBundleTree(absentDir, servesBoth, { cacheRoot: path.dirname(FIX) })
  check("an absent peer falls back to the running build", a.mapped.includes('zod') && a.mapped.includes('@deepseek-ai/dsh-tools'), JSON.stringify(a))
  const b = rewriteBundleTree(localDir, servesBoth, { cacheRoot: path.dirname(FIX) })
  check("a peer the bundle carries locally wins over the build", !b.mapped.includes('zod') && b.mapped.includes('@deepseek-ai/dsh-tools'), JSON.stringify(b))
  // restore both fixtures so a committed tree stays clean after the run
  writeFileSync(path.join(absentDir, 'index.js'), PRISTINE)
  writeFileSync(path.join(localDir, 'index.js'), PRISTINE)
  rmSync(path.join(localDir, 'node_modules'), { recursive: true, force: true })
  const c = rewriteBundleTree(absentDir, () => null, { cacheRoot: path.dirname(FIX) })
  check("a specifier neither tree has stays a real absent module", c.mapped.length === 0, JSON.stringify(c))
}

// A plain node builtin ('path', 'fs/promises') must never reach a resolver at
// all: hostEntry resolves a builtin to its own bare name and toUrl publishes it
// as a fake "file://path" URL. Measured in the hot-100 DSH batch, chunk 1: two
// bundled real plugins imported path/fs/promises bare and died with
// "Cannot find module '\\path\\'" until the filter exempted builtins. The
// recording resolver turns any consult into a visible leak.
{
  const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const PRISTINE = "import path from 'path'\nimport { readFile } from 'fs/promises'\nimport os from 'os'\n"
  const seen = []
  const spy = (s) => (seen.push(s), 'file:///C:/host/leak.js')
  const throughFilter = rewriteHostSpecifiers(PRISTINE, spy)
  check("a builtin import never reaches the resolver (filter layer)",
    seen.length === 0 && throughFilter.mapped.length === 0 && throughFilter.code === PRISTINE,
    JSON.stringify({ seen, code: throughFilter.code }))
  const dir = path.join(FIX, 'builtin-absent')
  writeFileSync(path.join(dir, 'index.js'), PRISTINE)
  rewriteBundleTree(dir, spy, { cacheRoot: path.dirname(FIX) })
  const back = readFileSync(path.join(dir, 'index.js'), 'utf8')
  check("a builtin import survives the bundle rewrite untouched (bundle layer)",
    seen.length === 0 && back === PRISTINE, JSON.stringify({ seen, back }))
  writeFileSync(path.join(dir, 'index.js'), PRISTINE)
}

// The detached scope is what the serve endpoint mounts bundles through once this
// plugin own fiber has been disposed (measured live: uid=78 at apply, uid=null at
// request). Two properties matter and neither is visible from the outside:
// registrations must land on the real service object, and a refusal must name the
// services actually missing rather than every service the bundle declared
// (@dfy-plugins/dsh-visualize asks for tools, fs, skills, sessionPersistence; a
// session with tools and skills was reported as lacking all four).
const { createDetachedScope } = await import("../src/detached-scope.js")
{
  const seen = []
  const scope = createDetachedScope({
    tools: { register: (d) => { seen.push(d.name); return { dispose () {} } } },
    commands: { register: () => ({ dispose () {} }) },
  })
  let ran = false
  scope.inject(["tools", "commands"], (inner) => { ran = true; inner.tools.register({ name: "landed" }) })
  check("inject runs when every named service is present", ran && seen.indexOf("landed") >= 0, "ran=" + ran)
  let overreached = false
  const out = scope.inject(["tools", "fs"], () => { overreached = true })
  check("inject declines a service the snapshot lacks", !overreached && out === undefined,
    "ran=" + overreached + " handle=" + typeof out)
  check("missing names only the absent ones", JSON.stringify(scope.missing(["tools", "fs", "skills"])) === JSON.stringify(["fs", "skills"]),
    JSON.stringify(scope.missing(["tools", "fs", "skills"])))
  // An effect must still collect its cleanup so removal can run it.
  let cleaned = 0
  scope.effect(() => () => { cleaned++ })
  const n = scope.dispose()
  check("dispose runs collected effect cleanups", cleaned === 1 && n >= 1, "cleaned=" + cleaned + " returned=" + n)
}
// A plugin must never be able to take the host down with it. Measured on a live
// session: a published bundle rejected inside apply, the rejection went unhandled
// because detached-scope dropped the promise its inject callback returned, and the
// DSH process died mid-batch - the six loads still queued behind it each got
// ECONNREFUSED, and the host log ended on that very line. Four properties hold the
// fix in place, and one of them caught a second bug: the retry loop applied the
// bundle again after it threw, so its tools registered twice.
const { loadDshBundle } = await import('../src/dsh-loader.js')
{
  let rejection = null
  process.on("unhandledRejection", (e) => { rejection = String((e && e.message) || e).slice(0, 60) })
  const landed = []
  const scope = createDetachedScope({
    tools: { register: (d) => { landed.push(d.name); return { dispose () {} } } },
    commands: { register: () => ({ dispose () {} }) },
  })
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'async-reject')
  let r = null
  let threw = null
  try {
    r = await loadDshBundle(fixture, scope, { cacheRoot: path.dirname(fixture), registered: new Set() })
  } catch (e) { threw = String(e && e.message).slice(0, 90) }
  await new Promise((res) => setTimeout(res, 400))
  check("a rejecting bundle does not escape as an unhandled rejection",
    rejection === null && threw === null, "rejection=" + JSON.stringify(rejection) + " threw=" + JSON.stringify(threw))
  check("the bundle own failure is blamed on the bundle",
    !!r && /its own apply\(\) failed/.test(String(r.error)), JSON.stringify(r && r.error))
  check("the rejection reason is carried into the message",
    !!r && /FIXTURE REJECTED ON PURPOSE/.test(String(r.error)), JSON.stringify(r && r.error))
  check("a throwing bundle is not applied twice",
    landed.length === 1, "registrations: " + JSON.stringify(landed))
  check("tools registered before the failure are still reported",
    !!r && (r.tools || []).length === 1, JSON.stringify(r && (r.tools || []).map((t) => t.name)))
  scope.dispose()
}

const roots = hostModulesRoots("C:/App/DeepSeek Harness.exe")
check("derives two roots from execPath", roots.length === 2 && roots[0].includes("app.asar") && roots[1].includes("asar.unpacked"), JSON.stringify(roots))

// The scope must see service entries that land AFTER it was built. Measured live
// on a GUI boot: the caller probes webServer through async ctx.inject callbacks
// that settle after apply() finished the synchronous part, and a scope that
// copied the snapshot at creation time reported "does not compose webServer"
// for a session that had been serving a browser UI on that service all along.
{
  const store = { tools: { register: () => ({ dispose () {} }) } }
  const scope = createDetachedScope(store)
  store.webServer = { ok: true }
  const seen = []
  const handle = scope.inject(["webServer"], (inner) => { seen.push(!!inner.webServer.ok) })
  check("a service added to the snapshot after creation is mountable",
    seen.length === 1 && seen[0] === true && handle && typeof handle.dispose === 'function',
    JSON.stringify(seen))
}

// ctx.plugin() must work the way cordis does, because a published bundle composes
// helper plugins through it (measured: dsh-univer-office died with
// "ctx.plugin is not a function" on the serve path). Three parts: it runs the
// apply, it declines a service the snapshot lacks exactly like inject, and a
// spawned rejection never escapes unhandled.
{
  const registered = []
  const scope = createDetachedScope({
    tools: { register: (d) => { registered.push(d.name); return { dispose () {} } } },
  })

  let unused = true
  const plain = typeof scope.plugin === 'function' ? scope.plugin(() => { unused = false }) : undefined
  check("plugin runs a declarative apply without inject", unused === false && plain && typeof plain.dispose === 'function', String(typeof plain))

  let spawned = false
  const handle = scope.plugin({
    inject: ['tools'],
    apply: (child) => { spawned = true; child.tools.register({ name: 'from-plugin' }) },
  }, {})
  check("plugin composes declared services and passes a real child scope",
    spawned && registered.indexOf('from-plugin') >= 0 && handle !== undefined,
    'spawned=' + spawned)

  const missingRun = scope.plugin({ inject: ['fs'], apply: () => { spawned = true } }, {})
  check("plugin declines a service the snapshot lacks", missingRun === undefined, String(missingRun))
  check("the declined plugin never ran", spawned === true, JSON.stringify(registered))

  // The univer-office shape: the bundle composes a helper plugin from INSIDE
  // its own inject callback. Measured live, the inject child scope carried no
  // plugin and the inner callback died with "ctx.plugin is not a function".
  const inner = []
  const nested = createDetachedScope({
    tools: { register: (d) => { inner.push(d.name); return { dispose () {} } } },
  })
  nested.inject(['tools'], (child) => {
    child.plugin((c) => { c.tools.register({ name: 'nested-helper' }) })
  })
  check("an inject child scope can compose further plugins",
    inner.indexOf('nested-helper') >= 0, JSON.stringify(inner))

  let rejection = null
  const unhandled = (e) => { rejection = String((e && e.message) || e).slice(0, 60) }
  process.on('unhandledRejection', unhandled)
  const rejecting = scope.plugin({
    inject: ['tools'],
    apply: async () => { throw new Error('PLUGIN FIXTURE REJECTED ON PURPOSE') },
  }, {})
  let caught = null
  try { await rejecting } catch (e) { caught = String((e && e.message) || e).slice(0, 60) }
  await new Promise((res) => setTimeout(res, 200))
  check("a spawned rejecting plugin rethrows to the awaiting caller",
    caught !== null && /PLUGIN FIXTURE REJECTED ON PURPOSE/.test(caught), JSON.stringify(caught))
  check("a spawned rejecting plugin does not escape as an unhandled rejection",
    rejection === null, JSON.stringify(rejection))
  process.off('unhandledRejection', unhandled)
}

// A bundle that subclasses the HOST's own cordis Service registers its instance
// through ctx.reflect.provide - measured live: dsh-univer-office defines
// `UniverService extends Service` whose constructor ends with
// `self.ctx.reflect.provide(name, self, check)`; without a reflect view the
// load died reading `.provide` of undefined. The service must land in the
// shared store so a later inject can circulate it.
{
  const scope = createDetachedScope({})
  const svc = { ok: true }
  scope.reflect.provide('univer', svc, () => true)
  let saw = false
  scope.inject(['univer'], (c) => { saw = c.univer === svc })
  check("reflect.provide lands a service the snapshot can circulate", saw, String(saw))
  check("reflect.define registers under the same store",
    scope.missing(['defined-thing']).length === 1 &&
    scope.reflect.define('defined-thing', 1) !== undefined &&
    scope.missing(['defined-thing']).length === 0, '')
}

console.log("")
console.log(fails ? "LOADER UNIT FAILED (" + fails + ")" : "LOADER UNIT PASSED")
process.exitCode = fails ? 1 : 0
