// Unit checks for the shared bridge registry (~/.dsh-pi-bridge/bridges.json) and
// for the pi-side /bridge-remove command that writes it. Everything runs inside a
// throwaway directory: the real registry of the machine is never read or written.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readRegistry, updateRegistry } from "../src/registry.js"

// Must be set before extensions/index.js is imported: CACHE_ROOT is read at load.
const ROOT = mkdtempSync(path.join(tmpdir(), "dsh-pi-registry-"))
process.env.DSH_PI_BRIDGE_HOME = ROOT

let fails = 0
const check = (label, ok, detail) => {
  if (ok) console.log("  ok   " + label)
  else { fails++; console.log("  FAIL " + label + (detail ? " :: " + detail : "")) }
}

const entry = (name) => ({ name, host: "dsh", mode: "replay", report: { tools: [], commands: [], skills: [] }, mirror: "" })
const onDisk = (file) => JSON.parse(readFileSync(file, "utf8")).bridges

console.log("registry module")
{
  const file = path.join(ROOT, "fresh", "bridges.json")
  check("a missing registry reads as empty", JSON.stringify((await readRegistry(file)).bridges) === "{}")
  await updateRegistry(file, { upserts: { "npm:a": entry("a") } })
  check("the first write creates the directory and file", existsSync(file) && "npm:a" in onDisk(file))
}
{
  const file = path.join(ROOT, "keep.json")
  writeFileSync(file, JSON.stringify({ bridges: { "npm:pi-only": entry("pi-only") } }))
  await updateRegistry(file, { upserts: { "npm:dsh-only": entry("dsh-only") } })
  const bridges = onDisk(file)
  check("a write keeps entries the writer did not mention", "npm:pi-only" in bridges && "npm:dsh-only" in bridges, Object.keys(bridges).join(","))
}
{
  // Another process forgets npm:b. A writer whose in-memory view still holds npm:b
  // must not bring it back: it only ever sends the keys it changed.
  const file = path.join(ROOT, "resurrect.json")
  writeFileSync(file, JSON.stringify({ bridges: { "npm:a": entry("a"), "npm:b": entry("b") } }))
  await updateRegistry(file, { removed: ["npm:b"] })
  const after = await updateRegistry(file, { upserts: { "npm:c": entry("c") } })
  check("a removed entry stays removed after a later write", !("npm:b" in onDisk(file)), Object.keys(onDisk(file)).join(","))
  check("the writer returns the disk state it wrote", !("npm:b" in after) && "npm:c" in after && "npm:a" in after)
}
{
  const file = path.join(ROOT, "corrupt.json")
  const garbage = "{ this is not json"
  writeFileSync(file, garbage)
  let threw = false
  try { await updateRegistry(file, { upserts: { "npm:x": entry("x") } }) } catch { threw = true }
  check("a corrupt registry is refused, not overwritten", threw && readFileSync(file, "utf8") === garbage)
}

console.log("pi /bridge-remove")
{
  const file = path.join(ROOT, "bridges.json")
  writeFileSync(file, JSON.stringify({ bridges: { "npm:a": entry("a"), "npm:b": entry("b") } }))
  const commands = new Map()
  const pi = new Proxy({ registerCommand (name, spec) { commands.set(name, spec) } }, {
    get (target, prop) { return prop in target ? target[prop] : () => {} },
  })
  const { default: extension } = await import("../extensions/index.js")
  await extension(pi)
  const handler = commands.get("bridge-remove") && commands.get("bridge-remove").handler
  check("the bridge-remove command is registered", typeof handler === "function")

  const notes = []
  let error = null
  try { await handler("npm:a", { ui: { notify: (text) => notes.push(text) } }) } catch (e) { error = e }
  check("bridge-remove runs without throwing", error === null, error && String(error.message || error))
  const bridges = onDisk(file)
  check("bridge-remove forgets the named bridge on disk", !("npm:a" in bridges), Object.keys(bridges).join(","))
  check("bridge-remove leaves the other bridges alone", "npm:b" in bridges)
  check("bridge-remove reports what it removed", notes.some((t) => String(t).startsWith("removed npm:a")), notes.join(" | "))
}

rmSync(ROOT, { recursive: true, force: true })
console.log("")
console.log(fails ? "REGISTRY UNIT FAILED (" + fails + ")" : "REGISTRY UNIT PASSED")
process.exitCode = fails ? 1 : 0
