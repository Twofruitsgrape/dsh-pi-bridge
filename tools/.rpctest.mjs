import { spawn } from "node:child_process"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const TMP = path.join(ROOT, ".tmp", "rpctest")
await mkdir(TMP, { recursive: true })
const J = path.join(TMP, "journal.txt")
await writeFile(J, "", "utf8")
const log = (m) => appendFile(J, m + "\n", "utf8")

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline"], {
  cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true,
})
log("spawned pid=" + child.pid)

let buf = ""
let gotResponse = false
child.stdout.on("data", (d) => {
  buf += d.toString("utf8")
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "")
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let rec = null
    try { rec = JSON.parse(line) } catch { log("NONJSON " + line.slice(0, 80)); continue }
    log("RECV type=" + rec.type + " cmd=" + (rec.command || "-") + " success=" + rec.success + " keys=" + Object.keys(rec.data || {}).slice(0, 12).join(","))
    if (rec.type === "response") gotResponse = true
    if (rec.type === "extension_ui_request") log("UIREQ " + rec.method)
  }
})
let err = ""
child.stderr.on("data", (d) => { err = (err + d.toString()).slice(-1500) })
child.on("error", (e) => log("SPAWN-ERROR " + e.message))
child.on("close", (c) => log("CLOSED code=" + c + " gotResponse=" + gotResponse))

const keep = setInterval(() => {}, 500)
await new Promise((r) => setTimeout(r, 4000))
child.stdin.write(JSON.stringify({ id: "q1", type: "get_state" }) + "\n")
log("sent get_state")
await new Promise((r) => setTimeout(r, 8000))
await log("after wait: gotResponse=" + gotResponse)
await log("stderr tail: " + err.replace(/\s+/g, " ").slice(-400))
clearInterval(keep)
child.kill()
await log("END")
process.exit(gotResponse ? 0 : 1)
