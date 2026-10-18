/**
 * A fingerprint of the bridge own code, so a long-lived daemon running older
 * code can be detected.
 *
 * A package version is not enough: it stays put while the code is edited under
 * it, and the daemon is deliberately long-lived - it survives a host restart - so
 * after any change the previous process answers health happily while executing
 * stale code. That is not hypothetical: a verification run here reported "nothing
 * callable" for two packages that a direct daemon query loaded fine, because the
 * daemon in place predated the fixes being measured.
 *
 * The digest covers the name and bytes of every module the daemon loads,
 * including both entry points. Any edit changes it.
 *
 * @module src/build-id.js
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Files whose behaviour the daemon would be running. */
const WATCHED = [
  'index.js',
  'extensions/index.js',
  'daemon/bootstrap.js',
  'daemon/run.mjs',
  'src/proxy.js',
  'src/resolve.js',
  'src/load.js',
  'src/manifest.js',
  'src/capture.js',
  'src/capabilities.js',
  'src/schema.js',
  'src/replay-dsh.js',
  'src/replay-pi.js',
  'src/restore.js',
  'src/stubs.js',
  'src/inert.js',
  'src/validate-args.js',
  'src/pi-aliases.js',
  'src/self-ref.js',
  'src/dsh-loader.js',
  'src/detached-scope.js',
  'src/serve.js',
  'src/dsh-host-client.js',
  'src/build-id.js',
]

/**
 * @param {string} root the package root
 * @returns {string|null} a short digest, or null when nothing could be read
 */
export function buildFingerprint (root) {
  const digest = createHash("sha256")
  let seen = 0
  for (const rel of WATCHED) {
    try {
      // The name goes in as well: moving code between files must change the
      // digest, since that changes which module the daemon actually executes.
      digest.update(rel).update('|')
      digest.update(readFileSync(path.join(root, ...rel.split('/'))))
      seen++
    } catch { /* a trimmed install simply carries fewer of these */ }
  }
  return seen ? digest.digest("hex").slice(0, 12) : null
}
