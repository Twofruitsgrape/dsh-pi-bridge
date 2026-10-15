/**
 * DSH-side acceptance: the exact path a DSH session takes, verified end to end.
 *
 * Loads this plugin own DSH entry against a recording stand-in scope, calls
 * pi_install, and asserts that the forwarding tool landing in DSH returns the
 * result pi itself computed. Nothing is translated: the package runs inside a
 * supervised pi process, so this test is about the round trip, not a mock.
 *
 * Needs the pi CLI; skips cleanly where pi is absent so it never fakes a pass.
 * Run: node daemon/dsh-proxy-e2e.mjs
 */
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import os from "node:os"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const TMP = path.join(ROOT, ".tmp", "dsh-proxy-e2e")
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })
process.env.DSH_PI_BRIDGE_HOME = TMP
process.env.DSH_PI_BRIDGE_DAEMON_PORT = "43157"

const npmBin = path.join(os.homedir(), "AppData", "Roaming", "npm")
const hasPi = existsSync(path.join(npmBin, "pi.cmd")) || existsSync(path.join(npmBin, "pi")) || existsSync("/usr/local/bin/pi")
if (!hasPi) { console.log("SKIP: no pi CLI on this machine"); process.exit(0) }

let failures = 0
function check (label, cond, detail) {
  if (cond) console.log("  ok   " + label)
  else { failures++; console.log("  FAIL " + label + (detail ? " :: " + String(detail).slice(0, 260) : "")) }
}

// A package with a skill and a published dependency: the two things a DSH user
// would notice missing if the proxy path were wrong.
const pkg = path.join(TMP, "fixture-pi-package")
await mkdir(path.join(pkg, "extensions"), { recursive: true })
await mkdir(path.join(pkg, "skills", "fixture-skill"), { recursive: true })
await writeFile(path.join(pkg, "package.json"), JSON.stringify({
  name: "fixture-pi-package", version: "1.0.0", type: "module",
  keywords: ["pi-package"], pi: { extensions: ["./extensions"], skills: ["./skills"] },
  dependencies: { "promise.try": "*" },
}, null, 2), "utf8")
await writeFile(path.join(pkg, "skills", "fixture-skill", "SKILL.md"),
  ["---", "name: fixture-skill", "description: A skill that travels as data.", "---", "", "Do the fixture thing.", ""].join("\n"), "utf8")
await writeFile(path.join(pkg, "extensions", "index.js"), [
  'import promiseTry from "promise.try";',
  '',
  'export default function (pi) {',
  '  pi.registerTool({',
  '    name: "fixture_tool",',
  '    label: "Fixture",',
  '    description: "Returns the input transformed, using a published dependency.",',
  '    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },',
  '    async execute (_id, params) {',
  '      const v = await promiseTry(() => String(params.text || "").toUpperCase())',
  '      return { content: [{ type: "text", text: "pi-said:" + v }] }',
  '    },',
  '  });',
  '  pi.registerCommand("fixture-cmd", { description: "A pi-side command", handler: async () => {} });',
  '}',
  '',
].join("\n"), "utf8")

// Recording stand-in for a DSH scope. defineTool is absent here, so the entry
// falls back to compiling the spec map itself, as the host would.
const registered = []
const skillProviders = []
const logs = []
const ctx = {
  logger: {
    info (m) { logs.push(String(m)) },
    warn (m) { logs.push("warn:" + m) },
    error () {}, debug () {},
  },
  tools: { register: (t) => registered.push(t) },
  commands: { register: () => {} },
  skills: { registerProvider: (f) => skillProviders.push(f) },
  on: () => () => {},
  inject (names, fn) {
    const scope = { tools: ctx.tools, skills: ctx.skills }
    for (const n of names) if (!(n in scope)) return undefined
    return fn(scope)
  },
}

const mod = await import(pathToFileURL(path.join(ROOT, "index.js")).href)
await mod.apply(ctx, {})
const hostToolNames = registered.map(t => t.name)
check("DSH entry registered its own tools", ["pi_install", "pi_preview", "bridge_status"].every(n => hostToolNames.includes(n)), hostToolNames.join(","))

const install = registered.find(t => t.name === "pi_install")
const out = await install.execute({ source: pkg.replace(/\\/g, "/") }, {})
console.log("  pi_install said: " + String(out.result).replace(/\s+/g, " ").slice(0, 300))
check("pi_install succeeded", out.ok === true, out.result)

// Derive the bridged name instead of hardcoding it: the prefix comes from the
// package name, and an assertion that guesses it fails for the wrong reason.
const bridged = registered.find(t => t.name.endsWith("_fixture_tool"))
check("a DSH forwarding tool was registered", !!bridged, registered.map(t => t.name).join(","))
check("parameter schema crossed from pi", !!(bridged && JSON.stringify(bridged.parameters).includes("text")), JSON.stringify(bridged && bridged.parameters))

if (bridged) {
  const r = await bridged.execute({ text: "through the bridge" }, {})
  check("forwarding tool returned the result pi computed", !!r.ok && String(r.result).includes("pi-said:THROUGH THE BRIDGE"), JSON.stringify(r))
  check("description marks it as running inside pi", /natively inside pi/.test(String(bridged.description)))
}

const mounted = await Promise.all(skillProviders.map(async (f) => (await f()).list()))
const skillNames = mounted.flat().map(s => s.name)
check("package skill mounted into DSH as data", skillNames.includes("fixture-skill"), skillNames.join(","))
check("pi-side command is reported", /fixture-cmd/.test(String(out.result)), String(out.result).slice(0, 200))

const status = registered.find(t => t.name === "bridge_status")
const st = await status.execute({}, {})
check("bridge_status reports a live daemon", !!st.ok && /"ok": true/.test(String(st.result)), String(st.result).slice(0, 240))

const list = registered.find(t => t.name === "bridge_list")
const ls = await list.execute({}, {})
check("bridge_list records proxy mode", /mode=proxy/.test(String(ls.result)), String(ls.result).slice(0, 240))

const again = await install.execute({ source: pkg.replace(/\\/g, "/") }, {})
check("reinstall still reports success", again.ok === true, String(again.result).slice(0, 200))

const remove = registered.find(t => t.name === "bridge_remove")
const rm1 = await remove.execute({ source: "npm:definitely-not-real-xyz" }, {})
check("removing an unknown source says so", /not bridged/.test(String(rm1.result)), String(rm1.result))

// Tear the daemon down so no orphaned pi process is left behind.
const shutdown = registered.find(t => t.name === "bridge_status")
void shutdown
const http = await import("node:http")
await new Promise((res) => {
  const req = http.request({ host: "127.0.0.1", port: 43157, path: "/shutdown", method: "GET", agent: false, timeout: 5000 }, (r) => { r.resume(); r.on("end", res) })
  req.on("error", res); req.on("timeout", () => { req.destroy(); res() }); req.end()
})

console.log("")
console.log(failures ? "DSH PROXY E2E FAILED (" + failures + ")" : "DSH PROXY E2E PASSED")
process.exitCode = failures ? 1 : 0
