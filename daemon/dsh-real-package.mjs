/**
 * Real-package forwarding check: install an actually published pi package
 * through the DSH entry and call its tool, end to end through the pi host
 * process. This is the case a fixture cannot cover: real network I/O, a real
 * provider, real published dependencies. It also proves the failure mode we
 * fixed - a tool whose dependency was missing - is gone.
 *
 * Needs pi and network. Skips where pi or the package is absent.
 * Run: node daemon/dsh-real-package.mjs
 */
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import os from "node:os"

// fileURLToPath, not pathname.slice(1): a pathname is percent-encoded, so a
// non-ASCII working directory would resolve to a path that does not exist.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const TMP = path.join(ROOT, ".tmp", "dsh-real-package")
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })
process.env.DSH_PI_BRIDGE_HOME = TMP
process.env.DSH_PI_BRIDGE_DAEMON_PORT = "43167"

const npmBin = path.join(os.homedir(), "AppData", "Roaming", "npm")
const hasPi = existsSync(path.join(npmBin, "pi.cmd")) || existsSync(path.join(npmBin, "pi"))
if (!hasPi) { console.log("SKIP: no pi CLI"); process.exit(0) }
const installed = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-web-access")
if (!existsSync(path.join(installed, "package.json"))) { console.log("SKIP: pi-web-access not installed"); process.exit(0) }

let failures = 0
const check = (l, c, d) => { if (c) console.log("  ok   " + l); else { failures++; console.log("  FAIL " + l + (d ? " :: " + String(d).slice(0, 240) : "")) } }

const registered = []
const ctx = {
  logger: { info () {}, warn () {}, error () {}, debug () {} },
  tools: { register: (t) => registered.push(t) },
  commands: { register: () => {} }, skills: { registerProvider: () => {} }, on: () => () => {},
  inject (names, fn) { const s = { tools: ctx.tools, skills: ctx.skills }; for (const n of names) if (!(n in s)) return; fn(s) },
}
const mod = await import(pathToFileURL(path.join(ROOT, "index.js")).href)
await mod.apply(ctx, {})
const install = registered.find(t => t.name === "pi_install")

// Install by npm spec: the way a DSH user actually reaches a published package.
const out = await install.execute({ source: "npm:pi-web-access" }, {})
check("pi_install of a published package succeeded", out.ok === true, out.result)
console.log("  report: " + String(out.result).replace(/\s+/g, " ").slice(0, 240))

const web = registered.find(t => /_web_search$/.test(t.name))
check("web_search forwarding tool registered", !!web, registered.map(t => t.name).join(","))

if (web) {
  const r = await web.execute({ query: "DeepSeek company" }, {})
  const text = String(r.result || "")
  check("real web_search ran inside pi and returned results", !!r.ok && text.length > 60 && !/failed/.test(text.slice(0, 40)), text.slice(0, 200))
}
const fetch = registered.find(t => /_fetch_content$/.test(t.name))
if (fetch) {
  const r = await fetch.execute({ url: "https://example.com" }, {})
  check("real fetch_content ran inside pi", !!r.ok && !/failed/.test(String(r.result).slice(0, 40)), String(r.result).slice(0, 160))
}

const http = await import("node:http")
await new Promise((res) => { const q = http.request({ host: "127.0.0.1", port: 43167, path: "/shutdown", method: "GET", agent: false, timeout: 5000 }, (x) => { x.resume(); x.on("end", res) }); q.on("error", res); q.on("timeout", () => { q.destroy(); res() }); q.end() })
console.log("")
console.log(failures ? "REAL PACKAGE CHECK FAILED (" + failures + ")" : "REAL PACKAGE CHECK PASSED")
process.exitCode = failures ? 1 : 0
