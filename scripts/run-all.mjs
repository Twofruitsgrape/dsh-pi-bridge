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
  ["bridge registry", ["scripts/registry-unit.mjs"]],
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

// A suite that never returns is not a passing suite. Two of these spawn real
// processes (a pi daemon, an Electron-free node host), and a package whose
// provider stalls leaves the child waiting forever - measured: the self-bridge
// suite printed every verdict and then kept the event loop alive on the daemon's
// pipes. A hard budget turns that into a named result instead of an unattended
// hang the operator has to diagnose by hand.
const SUITE_TIMEOUT_MS = Number(process.env.DSH_PI_BRIDGE_SUITE_TIMEOUT_MS || 240000)

let failed = 0
for (const [label, args] of SUITES) {
  const r = spawnSync(process.execPath, args.map(a => path.join(ROOT, a)), {
    stdio: ["ignore", "inherit", "inherit"], cwd: ROOT,
    timeout: SUITE_TIMEOUT_MS, killSignal: "SIGKILL",
  })
  if (r.status === 0) console.log(label + ": PASS")
  else if (r.signal) { console.log(label + ": TIMEOUT (" + Math.round(SUITE_TIMEOUT_MS / 1000) + "s, killed by " + r.signal + ")"); failed++ }
  else { console.log(label + ": FAIL (exit " + r.status + ")"); failed++ }
}
console.log(failed ? failed + " suite(s) failed" : "all suites passed")
process.exit(failed ? 1 : 0)
