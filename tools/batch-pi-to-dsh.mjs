/**
 * Batch test in the pi -> DSH direction, using real published packages.
 *
 * Everything goes through the product path a DSH session takes: the plugin's own
 * apply() against a recording scope, then pi_install's execute(). No side doors.
 * After installing, the bridged tool is actually called, because a tool that only
 * appears in a list has not been shown to work - the distinction that caught
 * several bugs in this bridge already.
 *
 * One shared supervised pi process holds every package, as it would in a DSH
 * session, so name collisions between packages are exercised too.
 *
 * Run: node tools/batch-pi-to-dsh.mjs [count]
 */
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile, appendFile } from "node:fs/promises"
import { pathToFileURL, fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const HOME = path.join(ROOT, ".tmp", "batch-pi")
await rm(HOME, { recursive: true, force: true })
await mkdir(HOME, { recursive: true })
process.env.DSH_PI_BRIDGE_HOME = HOME
// A port of its own so a daemon from another suite cannot be silently reused.
process.env.DSH_PI_BRIDGE_DAEMON_PORT = "43211"

const JOURNAL = path.join(HOME, "journal.txt")
const log = async (m) => { await appendFile(JOURNAL, m + "\n"); console.log(m) }

const npmBin = path.join(os.homedir(), "AppData", "Roaming", "npm")
const hasPi = existsSync(path.join(npmBin, "pi.cmd")) || existsSync(path.join(npmBin, "pi")) || existsSync("/usr/local/bin/pi")
if (!hasPi) { await log("SKIP: no pi CLI on this machine"); process.exit(0) }

/**
 * Packages to try. Defaults to the first wave already validated; a JSON file of
 * specs (one npm:/git: string per element) may be given so a fresh batch of real
 * published packages can be run without editing this file:
 *   node tools/batch-pi-to-dsh.mjs .tmp/pi-list.json
 */
const DEFAULT_SPECS = [
  'npm:pi-web-search',
  'npm:pi-memory',
  'npm:pi-goal-x',
]
let SPECS = DEFAULT_SPECS
if (process.argv[2] && process.argv[2].endsWith('.json')) {
  const { readFile: rf } = await import('node:fs/promises')
  SPECS = JSON.parse(await rf(process.argv[2], 'utf8'))
}
const LIMIT = process.argv[2] && process.argv[2].endsWith('.json')
  ? SPECS.length
  : Number(process.argv[2] || SPECS.length)


// The same recording stand-in the DSH-side suite uses, so this is the host path
// and not a bespoke mock.
const registered = []
const registeredSkills = []
const logs = []
const ctx = {
  logger: {
    info (m) { logs.push(String(m)) },
    warn (m) { logs.push("warn:" + m) },
    error (m) { logs.push("error:" + m) },
    debug () {},
  },
  tools: { register: (t) => registered.push(t) },
  commands: { register: () => {} },
  skills: { registerProvider: (f) => registeredSkills.push(f) },
  on: () => () => {},
  inject (names, fn) {
    const scope = { tools: ctx.tools, skills: ctx.skills }
    for (const n of names) if (!(n in scope)) return undefined
    return fn(scope)
  },
}

const mod = await import(pathToFileURL(path.join(ROOT, "index.js")).href)
await mod.apply(ctx, {})
const install = registered.find(t => t.name === "pi_install")
if (!install) { await log("FATAL: pi_install was not registered"); process.exit(1) }

const rows = []
for (const spec of SPECS.slice(0, LIMIT)) {
  const start = Date.now()
  await log("\n### " + spec)
  let out
  try {
    out = await install.execute({ source: spec }, {})
  } catch (e) {
    // execute is wrapped by the product's own guard, so reaching here means the
    // guard itself failed: worth recording as a defect, not a package problem.
    await log("  THREW outside the guard: " + String(e && e.message).slice(0, 200))
    rows.push({ spec, ok: false, reason: "threw: " + String(e && e.message).slice(0, 120), tools: [] })
    continue
  }
  const text = String(out && out.result || "")
  const toolLine = (text.match(/tools: ([^\n]*)/) || [])[1] || ""
  const tools = toolLine.trim() && toolLine.trim() !== "none" ? toolLine.split(",").map(s => s.trim()) : []
  const skillLine = (text.match(/skills mounted: ([^\n]*)/) || [])[1] || ""
  // Commands live in pi, not DSH, so pi_install reports them on their own line.
  // Reading only the tools line made command-only packages look like failures:
  // five of twelve real packages had registered commands and skills while
  // reporting "tools=none".
  const cmdLine = (text.match(/pi slash commands registered in pi: ([^\n]*)/) || [])[1] || ""
  const cmds = cmdLine.trim() ? cmdLine.split(",").map((s) => s.trim()).filter(Boolean) : []
  await log("  ok=" + (out && out.ok) + "  tools=" + (tools.length ? tools.join(", ") : "none"))
  if (cmds.length) await log("  commands(in pi): " + cmds.slice(0, 8).join(", ") + (cmds.length > 8 ? " +" + (cmds.length - 8) : ""))
  if (skillLine.trim() && skillLine.trim() !== "none") await log("  skills=" + skillLine.trim())
  const notes = text.split("\n").filter(l => /nothing callable|reported by pi at load|skipped|load errors|failed/i.test(l))
  for (const n of notes) await log("  " + n.trim().slice(0, 220))
  rows.push({
    spec, ok: !!(out && out.ok), tools, skills: skillLine.trim(), commands: cmds,
    note: notes.join(" | ").slice(0, 220),
    message: out && !out.ok ? text.slice(0, 200) : "",
  })
  await log("  (" + ((Date.now() - start) / 1000).toFixed(1) + "s)")
}

// Call what arrived. Arguments are empty on purpose: the point is that the call
// travels to pi and pi's own code answers - whether by working or by rejecting
// the input the way the real package does. A stub would produce neither.
await log("\n### calling bridged tools")
const calls = []
for (const row of rows) {
  for (const name of row.tools.slice(0, 2)) {
    const tool = registered.find(t => t.name === name)
    if (!tool) { calls.push({ name, verdict: "NOT REGISTERED" }); continue }
    let res
    try { res = await tool.execute({}, {}) }
    catch (e) { calls.push({ name, verdict: "THREW " + String(e && e.message).slice(0, 120) }); continue }
    const body = String(res && res.result || "")
    const verdict = res && res.ok ? "returned" : "reported-failure"
    await log("  " + name + " -> " + verdict + ": " + body.replace(/\s+/g, " ").slice(0, 150))
    calls.push({ name, verdict, body: body.slice(0, 150) })
  }
}

const installed = rows.filter(r => r.ok)
const withTools = rows.filter(r => r.tools.length)
const withAnything = rows.filter(r => r.tools.length || (r.commands || []).length || (r.skills || "").length)
await log("\n=== SUMMARY ===")
await log("packages attempted: " + rows.length)
await log("installed ok:       " + installed.length)
await log("arriving with tools:" + withTools.length + "  (" + withTools.map(r => r.spec.replace("npm:", "")).join(", ") + ")")
// A package with no callable tool is not a failure: a command-only or skill-only
// extension has nothing for the receiving host to invoke, and says so.
await log("registered something: " + withAnything.length)
await log("no callable tool:    " + rows.filter(r => r.ok && !r.tools.length).map(r => r.spec.replace("npm:", "") + (r.commands.length ? "[cmds]" : "")).join(", "))
await log("nothing at all:      " + rows.filter(r => r.ok && !r.tools.length && !r.commands.length && !(r.skills || "").trim()).map(r => r.spec.replace("npm:", "")).join(", ") || "none")
await log("failed:             " + rows.filter(r => !r.ok).map(r => r.spec.replace("npm:", "") + "=" + r.message.slice(0, 60)).join("; "))
await log("bridged calls:      " + calls.length + ", returning from pi: " + calls.filter(c => c.verdict === "returned").length
  + ", reporting failure from pi: " + calls.filter(c => c.verdict === "reported-failure").length
  + ", throwing: " + calls.filter(c => /THREW|NOT REG/.test(c.verdict)).length)
await log("journal: " + JOURNAL)
