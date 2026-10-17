// Ask the running daemon for the raw /load replies of the two packages that
// reported nothing. The batch summary only shows what the bridge chose to say;
// the daemon reply is the underlying fact.
const { writeFile } = await import("node:fs/promises")
const post = (path, body) => new Promise((res, rej) => {
  const req = require("node:http").request({ host: "127.0.0.1", port: 43211, path, method: "POST", agent: false, timeout: 90000, headers: { "content-type": "application/json" } }, (r) => {
    let d = ""; r.on("data", (c) => { d += c }); r.on("end", () => { try { res(JSON.parse(d)) } catch { rej(new Error("bad json " + d.slice(0, 80))) } })
  })
  req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")) })
  req.write(JSON.stringify(body)); req.end()
})
const get = (path) => new Promise((res, rej) => {
  const req = require("node:http").request({ host: "127.0.0.1", port: 43211, path, method: "GET", agent: false, timeout: 15000 }, (r) => {
    let d = ""; r.on("data", (c) => { d += c }); r.on("end", () => { try { res(JSON.parse(d)) } catch { rej(new Error("bad json")) } })
  })
  req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")) })
  req.end()
})
const main = async () => {
  const out = []
  try { out.push(["health", await get("/health")]) } catch (e) { out.push(["health", "ERR " + e.code]); return finish(out) }
  for (const [label, root] of [
    ["fff", "E:/Projects/testanything/dsh\u63d2\u4ef6\u5b89\u88c5/dsh-pi-bridge/.tmp/batch-pi/packages/npm__ff-labs_pi-fff"],
    ["agent-comms", "E:/Projects/testanything/dsh\u63d2\u4ef6\u5b89\u88c5/dsh-pi-bridge/.tmp/batch-pi/packages/npm__agent-comms"],
  ]) {
    try {
      const r = await post("/load", { root })
      out.push([label, { ok: r.ok, added: (r.added || []).length, errors: r.errors, notes: (r.notes || []).slice(0, 4) }])
    } catch (e) { out.push([label, "ERR " + e.message]) }
  }
  finish(out)
}
function finish (out) {
  const text = out.map(([k, v]) => "=== " + k + " ===\n" + JSON.stringify(v, null, 1)).join("\n\n")
  writeFile("E:/Projects/testanything/dsh\u63d2\u4ef6\u5b89\u88c5/dsh-pi-bridge/daemon-answers.txt", text)
  console.log(text)
}
main().catch((e) => console.log("FATAL " + e.message))
