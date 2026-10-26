// Unit checks for the runtime DSH bundle loader: specifier classification and
// host rewriting. They need no host, so they can gate the publish path.
import { isHostSpecifier, rewriteHostSpecifiers, rewriteBundleTree, hostModulesRoots, resolveBundleConfig } from "../src/dsh-loader.js"
import { toToolSchema } from "../src/schema.js"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
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
// Whitespace after `from` is optional, and a minified bundle writes none:
// npm:dsh-context 0.77.0 starts its single line with
// `import{deriveEventMessage as n}from"@deepseek-ai/dsh-session"`. The rewriter
// required `from\s+`, so it rewrote nothing in that file and the load died with
// "Cannot find package '@deepseek-ai/dsh-session'" - a host module the build
// ships. A fix that only widens `from` must not lose the other two shapes.
const minified = [
  ["import{x}from" + JSON.stringify(SPEC), "minified named import (no space after from)"],
  ["import" + JSON.stringify(SPEC), "minified side-effect import (no space after import)"],
  ["export{x}from" + JSON.stringify(SPEC), "minified re-export (no space after from)"],
]
for (const [src, label] of minified) {
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

// The npm-installed node_modules subtree inside the cache copy must be walked:
// nested packages carry the very specifiers the fallback exists for. Measured
// live: @8kugames/dsh-zed-acp's sdk dist imports bare 'zod' (the build ships
// zod, so the resolve layer never provisioned it), and dsh-plugin-wwrs-voice's
// nested @deepseek-ai/dsh-* files import bare 'cordis' (family). When the walk
// skipped node_modules both stayed bare and both loads died with
// MODULE_NOT_FOUND.
{
  const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const NESTED = [
    "import { x } from '@deepseek-ai/dsh-tools'",
    "import { z } from 'zod'",
    "export const both = [x, z]",
  ].join(String.fromCharCode(10))
  const dir = path.join(FIX, 'peer-nested')
  const nested = path.join(dir, 'node_modules', '@vendor', 'nested')
  const servesBoth = (s) => (s === '@deepseek-ai/dsh-tools' ? 'C:/host/tools.js' : s === 'zod' ? 'C:/host/zod-entry.js' : null)
  mkdirSync(nested, { recursive: true })
  writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: '@vendor/nested', version: '1.0.0', main: 'dist.js' }))
  writeFileSync(path.join(nested, 'dist.js'), NESTED)
  const n = rewriteBundleTree(dir, servesBoth, { cacheRoot: path.dirname(FIX) })
  const back = readFileSync(path.join(nested, 'dist.js'), 'utf8')
  check("a nested node_modules file gets the family rewrite",
    back.includes('file:///C:/host/tools.js'), JSON.stringify({ mapped: n.mapped, back: back.slice(0, 110) }))
  check("a nested node_modules file gets the third-party fallback",
    n.mapped.includes('zod') && back.includes('file:///C:/host/zod-entry.js'), JSON.stringify(n.mapped))
  // Re-running over the already-rewritten tree changes nothing: file: URLs are
  // left alone, so reinstalling or reloading a live cache copy cannot corrupt it.
  const again = rewriteBundleTree(dir, servesBoth, { cacheRoot: path.dirname(FIX) })
  const twice = readFileSync(path.join(nested, 'dist.js'), 'utf8')
  check("re-running over rewritten urls leaves them alone",
    again.mapped.length === 0 && twice === back, JSON.stringify({ mapped: again.mapped, changed: twice !== back }))
  rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true })
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

// Three module shapes carry a plugin, and only one of them used to work. The
// trap is specific: on a default-exported FUNCTION, `.apply` is
// Function.prototype.apply. It is a function, so a typeof guard passes, and
// calling it raises "Function.prototype.apply was called on undefined, which is
// undefined and not a function" - which the loader then reported as the bundle's
// own apply() failing. Measured on npm:dsh-deja (export default apply) and
// npm:@yadsh/dsh-qa-surface in the same pi->DSH batch; both packages are fine.
{
  const { bundlePlugin } = await import("../src/plugin-shape.js")
  let called = 0
  const fnOnly = { default: function apply () { called++ } }
  const resolvedFn = bundlePlugin(fnOnly)
  check("a default-exported function is resolved as the plugin itself",
    !!resolvedFn && resolvedFn.kind === "apply" && resolvedFn.source === "export default",
    JSON.stringify(resolvedFn && { kind: resolvedFn.kind, source: resolvedFn.source }))
  resolvedFn && resolvedFn.construct({}, {})
  check("and the call reaches the module's own function, not Function.prototype.apply",
    called === 1, "times the module function ran: " + called)

  const FIXROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const shapes = [
    ["shape-default-fn", "shape_default_fn_tool", "a default-exported apply function"],
    ["shape-default-class", "shape_default_class_tool", "a default-exported class (constructed)"],
    ["shape-object-default", "shape_object_default_tool", "a default-exported object plugin"],
  ]
  for (const [dir, tool, label] of shapes) {
    const landed = []
    const scope = createDetachedScope({
      tools: { register: (d) => { landed.push(d.name); return { dispose () {} } } },
      commands: { register: () => ({ dispose () {} }) },
    })
    const fixture = path.join(FIXROOT, dir)
    let r = null
    try {
      r = await loadDshBundle(fixture, scope, { cacheRoot: FIXROOT, registered: new Set() })
    } catch (e) {
      r = { error: "threw: " + String((e && e.message) || e) }
    }
    check(label + " loads and registers its tool",
      !!r && !r.error && landed.includes(tool), "error=" + JSON.stringify(r && r.error) + " landed=" + JSON.stringify(landed))
    scope.dispose()
  }
}

// The one failure that takes the host down with it. npm:@michengai/dsh-automation
// reads ctx.connection and calls .rpc.handle(): the HOST's implementation reads
// webServer off a fiber that never injected it, the throw lands on the host's own
// registration path inside the bundle's continuation, and because apply() had
// already resolved nothing of ours was on the stack - the host printed
// "dsh: fatal load failure" and exited. The guard wraps the one service whose
// misuse does that, so the failure stays attributed and the session lives.
{
  const FIXROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const uncaught = []
  const handler = (e) => { uncaught.push(String((e && e.message) || e)) }
  process.on('uncaughtException', handler)
  const landed = []
  const scope = createDetachedScope({
    tools: { register: (d) => { landed.push(d.name); return { dispose () {} } } },
    commands: { register: () => ({ dispose () {} }) },
    connection: {
      rpc: {
        handle () { throw new Error('cannot get property "webServer" without inject') },
      },
    },
  })
  const fixture = path.join(FIXROOT, 'connection-throw')
  let r = null
  try {
    r = await loadDshBundle(fixture, scope, { cacheRoot: FIXROOT, registered: new Set(), settleMs: 250 })
  } catch (e) {
    r = { error: 'threw: ' + String((e && e.message) || e) }
  }
  await new Promise((res) => setTimeout(res, 300))
  process.off('uncaughtException', handler)
  check('a deferred connection call that throws never reaches the process',
    uncaught.length === 0, JSON.stringify(uncaught))
  check('the load names the contained call and its reason',
    !!r && /connection\.rpc\.handle/.test(String(r.error)) && /webServer/.test(String(r.error)),
    JSON.stringify(r && r.error))
  check('the tool registered before the contained failure is still reported',
    landed.includes('connection_throw_tool'), JSON.stringify(landed))
  scope.dispose()
}

// The real cause behind the fatal load failure, with no host involved: a bundle
// runs its activation inside ctx.effect(async () => { ... }), the effect shim
// calls the factory and drops the promise it returns, and the rejection is
// unowned - which terminates the process. npm:@michengai/dsh-automation hit
// exactly this; its stack named connection.rpc, which is where it threw, not why
// it escaped.
{
  const FIXROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const unhandled = []
  const onUnhandled = (e) => { unhandled.push(String((e && e.message) || e)) }
  process.on('unhandledRejection', onUnhandled)
  const landed = []
  const scope = createDetachedScope({
    tools: { register: (d) => { landed.push(d.name); return { dispose () {} } } },
    commands: { register: () => ({ dispose () {} }) },
  })
  const fixture = path.join(FIXROOT, 'effect-reject')
  let r = null
  try {
    r = await loadDshBundle(fixture, scope, { cacheRoot: FIXROOT, registered: new Set(), settleMs: 250 })
  } catch (e) {
    r = { error: 'threw: ' + String((e && e.message) || e) }
  }
  await new Promise((res) => setTimeout(res, 300))
  process.off('unhandledRejection', onUnhandled)
  check('a rejecting async effect factory does not escape as an unhandled rejection',
    unhandled.length === 0, JSON.stringify(unhandled))
  check('the load reports the contained effect failure with its reason',
    !!r && /effect factory/.test(String(r.error)) && /EFFECT FACTORY REJECTED/.test(String(r.error)),
    JSON.stringify(r && r.error))
  check('the tool the bundle registered is still reported',
    landed.includes('effect_reject_tool'), JSON.stringify(landed))
  scope.dispose()
}

// The entry directory is not always a plain one. npm:@ljwei-stak/dsh-mv-cli
// publishes main "./.dsh-plugin/index.mjs", and the tree walker skipped every
// dot-directory, so that entry's bare '@deepseek-ai/schemastery' import was never
// rewritten and the load died with "Cannot find package" for a package the build
// ships. Walking the directory an entry lives in is the fix; other dot-dirs stay
// skipped.
{
  const tmp = path.join(os.tmpdir(), 'dsh-pi-bridge-dotdir-' + process.pid)
  const entryDir = path.join(tmp, '.dsh-plugin')
  mkdirSync(entryDir, { recursive: true })
  const entry = path.join(entryDir, 'index.js')
  writeFileSync(entry, "import z from '@deepseek-ai/schemastery'\nexport const apply = () => z\n")
  const { rewriteBundleTree } = await import('../src/dsh-loader.js')
  const host = () => 'C:/host/schemastery/index.js'
  const withoutEntry = rewriteBundleTree(tmp, host, { cacheRoot: os.tmpdir() })
  const before = readFileSync(entry, 'utf8')
  check('a dot directory is still skipped when no entry lives in it',
    /@deepseek-ai\/schemastery/.test(before) && !/file:\/\//.test(before), before.slice(0, 100))
  const withEntry = rewriteBundleTree(tmp, host, { cacheRoot: os.tmpdir(), entry })
  const after = readFileSync(entry, 'utf8')
  check('the directory an entry lives in is walked even when its name starts with a dot',
    /file:\/\/\/C:\/host\/schemastery/.test(after), after.slice(0, 120))
  check('and the walk reports what it mapped',
    withEntry.mapped.includes('@deepseek-ai/schemastery') || withoutEntry.mapped.includes('@deepseek-ai/schemastery'),
    JSON.stringify({ withEntry: withEntry.mapped, withoutEntry: withoutEntry.mapped }))
  rmSync(tmp, { recursive: true, force: true })
}

// A bundle's own bookkeeping must not be refused. npm:dsh-remote-mobile sets
// ctx.__dsh_rm_index_mounted__ = true in apply(); a set trap that always returned
// false raised "'set' on proxy: trap returned falsish" in strict mode and the
// whole bundle failed over a private flag.
{
  const FIXROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const landed = []
  const scope = createDetachedScope({
    tools: { register: (d) => { landed.push(d.name); return { dispose () {} } } },
    commands: { register: () => ({ dispose () {} }) },
  })
  const fixture = path.join(FIXROOT, 'ctx-write')
  let r = null
  try {
    r = await loadDshBundle(fixture, scope, { cacheRoot: FIXROOT, registered: new Set() })
  } catch (e) {
    r = { error: 'threw: ' + String((e && e.message) || e) }
  }
  check('a bundle can keep a private flag on ctx without failing',
    !!r && !r.error && landed.includes('ctx_write_tool'),
    "error=" + JSON.stringify(r && r.error) + " landed=" + JSON.stringify(landed))
  scope.dispose()
}

// The tree walker has its own prefilter, and it needed the same tolerance: a
// minified file was rejected before the rewriter ever saw it, so `mapped` stayed
// empty and the load blamed a host package that was present.
{
  const tmp = path.join(os.tmpdir(), 'dsh-pi-bridge-minified-' + process.pid)
  mkdirSync(tmp, { recursive: true })
  const file = path.join(tmp, 'index.js')
  writeFileSync(file, 'import{z as t}from"@deepseek-ai/schemastery";export const apply=()=>t\n')
  const host = () => 'C:/host/schemastery/index.js'
  const r = rewriteBundleTree(tmp, host, { cacheRoot: os.tmpdir() })
  const after = readFileSync(file, 'utf8')
  check('a minified file is not skipped by the prefilter',
    /file:\/\/\/C:\/host/.test(after) && r.mapped.includes('@deepseek-ai/schemastery'),
    "code=" + after.slice(0, 90) + " mapped=" + JSON.stringify(r.mapped))
  rmSync(tmp, { recursive: true, force: true })
}

const roots = hostModulesRoots("C:/App/DeepSeek Harness.exe")
check("finds the unpacked runtime the 0.2.1 layout ships",
  roots[0] === "C:\\App\\resources\\app\\dsh\\node_modules", JSON.stringify(roots))
check("keeps the legacy asar roots for older installs",
  roots.some((r) => r.endsWith("app.asar\\dsh\\node_modules")) && roots.some((r) => r.endsWith("app.asar.unpacked\\dsh\\node_modules")), JSON.stringify(roots))
check("an empty execPath derives no roots", hostModulesRoots("").length === 0, JSON.stringify(hostModulesRoots("")))

{
  const staleUrl = "file:///C:/Apps/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js"
  const staleSrc = 'import { defineTool } from "' + staleUrl + '"'
  const healed = rewriteHostSpecifiers(staleSrc, () => null, { hostRoots: [process.cwd()] })
  check("a stale asar host url is repointed at the running build",
    !healed.code.includes("app.asar") && healed.code.includes("@deepseek-ai/dsh-tools/lib/index.js"), healed.code)
  const kept = rewriteHostSpecifiers(staleSrc, () => null, { hostRoots: ["C:/no-such-host-root-for-this-test"] })
  check("a stale url with no current root is left untouched", kept.code.includes("app.asar"), kept.code)
}

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

// A bundle's Config schema resolves to its defaults; passing the schema through
// raw is what made agnes-image's tool defaults non-lossless JSON.
{
  const callableSchema = (data) => ({ model: "m1", defaultSize: "1K", ...data })
  const resolved = resolveBundleConfig(callableSchema)
  check("a callable schema resolves to its defaults", resolved.defaultSize === "1K" && resolved.model === "m1", JSON.stringify(resolved))
  const parseSchema = { parse: (data) => ({ defaultRatio: "1:1", ...data }) }
  check("a parse-style schema resolves through parse({})", resolveBundleConfig(parseSchema).defaultRatio === "1:1")
  const demanding = () => { throw new Error("requires a value") }
  check("a schema that demands a value keeps the raw argument", resolveBundleConfig(demanding) === demanding)
  check("a missing config resolves to an empty object", JSON.stringify(resolveBundleConfig(null)) === "{}")
  check("a plain config object passes through", resolveBundleConfig({ x: 1 }).x === 1)
}

// ctx.get() is how a bundle's execute() reads host services; the detached scope
// must answer it from the snapshot, on the root scope and inside inject children.
{
  const credentials = { resolve: () => "k" }
  const scope = createDetachedScope({ credentials })
  check("detached scope get() returns the snapshot service", scope.get("credentials") === credentials)
  check("detached scope get() leaves an uncaptured name undefined", scope.get("attachments") === undefined)
  let inner = "callback-not-run"
  scope.inject(["credentials"], (child) => { inner = child.get("credentials") })
  check("an inject child carries get() too", inner === credentials, String(inner))
  const toolsService = { register: () => ({ dispose () {} }) }
  const wide = createDetachedScope({ credentials, tools: toolsService, commands: {} })
  let unnamed = "callback-not-run"
  wide.inject(["commands"], (child) => { unnamed = child.tools })
  check("an inject child still sees services it did not name", unnamed === toolsService, String(unnamed))
  {
    // A bundle's own un-awaited ctx.inject(..., async () => { throw }) used to become
    // an unhandled rejection and kill the host process (npm:@michengai/dsh-automation).
    const rejectScope = createDetachedScope({ tools: toolsService })
    const handle = rejectScope.inject(["tools"], async () => { throw new Error("deferred boom") })
    let observed = false
    try { await handle } catch { observed = true }
    check("a rejecting inject callback stays visible to an awaiting caller", observed)
    const ignoredScope = createDetachedScope({ tools: toolsService })
    const leaked = []
    const onLeak = (e) => leaked.push(String((e && e.message) || e).slice(0, 80))
    process.on("unhandledRejection", onLeak)
    try {
      ignoredScope.inject(["tools"], async () => { throw new Error("unobserved boom") })
      await new Promise((r) => setTimeout(r, 50))
    } finally { process.off("unhandledRejection", onLeak) }
    check("an ignored rejecting inject handle is not reported as unhandled", leaked.length === 0, leaked.join(" | "))
  }
  {
    let built = null
    class Svc { constructor (ctx, cfg) { built = { hasTools: !!ctx.tools, cfg } } }
    const classScope = createDetachedScope({ tools: toolsService })
    classScope.plugin(Svc, { a: 1 })
    check("a plugin given as a class is constructed, not called",
      built !== null && built.hasTools === true && built.cfg.a === 1, JSON.stringify(built))
  }
}

// Tool parameters reach the host as a compiled object schema. An empty map that
// compiles to nothing is the 'type: null' the provider refused the whole turn over.
{
  const empty = toToolSchema({})
  check("an empty parameter map compiles to an object schema", empty.type === "object" && typeof empty.properties === "object", JSON.stringify(empty))
  const withBool = toToolSchema({ verbose: { type: "boolean", description: "d" } })
  check("a boolean parameter lands in the compiled properties", withBool.properties.verbose.type === "boolean", JSON.stringify(withBool))
}

console.log("")
console.log(fails ? "LOADER UNIT FAILED (" + fails + ")" : "LOADER UNIT PASSED")
process.exitCode = fails ? 1 : 0
