// Unit checks for the runtime DSH bundle loader: specifier classification and
// host rewriting. They need no host, so they can gate the publish path.
import { isHostSpecifier, rewriteHostSpecifiers, hostModulesRoots } from "../src/dsh-loader.js"
import { fileURLToPath } from "node:url"
import path from "node:path"

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

console.log("")
console.log(fails ? "LOADER UNIT FAILED (" + fails + ")" : "LOADER UNIT PASSED")
process.exitCode = fails ? 1 : 0
