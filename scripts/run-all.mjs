/**
 * Published test entry. Runs everything that needs no network: the pipeline
 * self-test and both host entry checks. Real-host and network regression cases
 * live in tools/ and are run from the repository, not from the tarball.
 * Run: npm test
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const SUITES = [
  ["offline pipeline", ["scripts/selftest.mjs"]],
  ["host entries", ["scripts/entry-check.mjs"]],
  ["self-bridge", ["tools/selfhost-check.mjs"]],
  ["loader rules", ["scripts/loader-unit.mjs"]],
  ["pi proxy", ["daemon/acceptance.mjs"]],
  ["dsh proxy (DSH side)", ["daemon/dsh-proxy-e2e.mjs"]],
  ["dsh host forwarding (pi side)", ["daemon/dsh-host-e2e.mjs"]],
]

// A missing suite file is a packaging bug, not an optional skip: fail loudly.
const { existsSync } = await import('node:fs')
let missing = 0
for (const [label, args] of SUITES) {
  for (const a of args) {
    if (!existsSync(path.join(ROOT, a))) { console.log(label + ': MISSING ' + a); missing++ }
  }
}
if (missing) { console.log(missing + ' suite file(s) missing from this install'); process.exit(1) }

let failed = 0
for (const [label, args] of SUITES) {
  const r = spawnSync(process.execPath, args.map(a => path.join(ROOT, a)), { stdio: ["ignore", "inherit", "inherit"], cwd: ROOT })
  if (r.status === 0) console.log(label + ": PASS")
  else { console.log(label + ": FAIL (exit " + r.status + ")"); failed++ }
}
console.log(failed ? failed + " suite(s) failed" : "all suites passed")
process.exit(failed ? 1 : 0)
