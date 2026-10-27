/**
 * Would a stranger's install actually run?
 *
 * Every other check here runs against the working tree, where a file exists even
 * if `files` forgot to publish it. That exact class of bug has bitten this bridge
 * before - the README lists "a missing file in the publish list" among the things
 * only a real host caught - and it is invisible until someone else installs the
 * package. So this packs the tarball, extracts it somewhere empty, and runs the
 * entry check on the extracted copy: no working tree, no node_modules, nothing
 * the repository happens to have lying around.
 *
 * Two questions are asked, and they are different ones:
 *   - does everything the runtime loads actually ship?
 *   - does the shipped copy load, in both hosts?
 *
 * The second is answered by scripts/entry-check.mjs from inside the extracted
 * package, which is why that script has to be self-contained under its own root.
 *
 * Run: node scripts/pack-check.mjs      (PACK_CHECK_KEEP=1 keeps the extraction)
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { extractTgz } from '../src/tar.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const KEEP = process.env.PACK_CHECK_KEEP === '1'

let failures = 0
function check (label, cond, detail) {
  if (cond) console.log('  ok   ' + label)
  else { failures++; console.log('  FAIL ' + label + (detail ? ' :: ' + detail : '')) }
}

/** Files a stranger's copy must contain, because the runtime reads them. */
const REQUIRED = [
  'package.json',
  'index.js',
  'extensions/index.js',
  'daemon/run.mjs',
  'daemon/bootstrap.js',
  'cordis.patch.yml',
  'skills/dsh-pi-bridge/SKILL.md',
  'scripts/entry-check.mjs',
]

/**
 * Trees that are runtime through and through, so every file in them must ship.
 *
 * daemon/ is deliberately not one: it holds the two runtime files (named in
 * REQUIRED) alongside standalone harnesses such as dsh-real-package.mjs, which
 * nothing imports and which therefore should not be published. Asserting the
 * whole directory would have meant publishing measurement scaffolding to keep a
 * check green, which is the wrong way round.
 */
const RUNTIME_TREES = ['src']

/** Measurement scaffolding and local state: never published. */
const DEV_ONLY = ['.workbuddy', '.tmp', 'tools/batch-pi-to-dsh.mjs', 'tools/batch-dsh-to-pi.mjs', 'tools/batch-pi-side.mjs']

async function listFiles (dir, prefix = '') {
  const out = []
  let names
  try { names = await readdir(dir) } catch { return out }
  for (const n of names) {
    const full = path.join(dir, n)
    const rel = prefix ? prefix + '/' + n : n
    const s = await stat(full)
    if (s.isDirectory()) out.push(...await listFiles(full, rel))
    else out.push(rel)
  }
  return out
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-pi-bridge-pack-'))
try {
  console.log('packing the published tarball')
  const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], {
    cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
  })
  const info = JSON.parse(packed.slice(packed.indexOf('[')))[0]
  const manifest = await readFile(path.join(ROOT, 'package.json'), 'utf8')
  const declared = (JSON.parse(manifest).files || []).length
  check('npm pack produced a tarball', !!info.filename, JSON.stringify(info).slice(0, 160))
  check('the published file list is declared, not accidental', declared > 0, declared + ' entries in files')
  check('the tarball has content', info.entryCount > 10, String(info.entryCount) + ' files')

  // Extract rather than install: peer dependencies must not be fetched, and the
  // question here is what the package contains, not how npm resolves it. The
  // bridge's own reader does the unpacking, so this needs no system tar and
  // exercises the same code path a cached package goes through.
  const pkg = path.join(tmp, 'x')
  await rm(pkg, { recursive: true, force: true })
  await extractTgz(path.join(tmp, info.filename), pkg)
  const shipped = new Set(await listFiles(pkg))

  for (const rel of REQUIRED) check('ships ' + rel, shipped.has(rel))
  for (const rel of DEV_ONLY) check('does not ship ' + rel, !shipped.has(rel))

  // The general form of the same question: every module the runtime loads lives
  // in one of these trees, so a file present in the repo and absent here is a
  // module that cannot be imported by whoever installed this.
  const missing = []
  for (const tree of RUNTIME_TREES) {
    for (const rel of await listFiles(path.join(ROOT, tree), tree)) {
      if (!shipped.has(rel)) missing.push(rel)
    }
  }
  check('every module in src/ ships', missing.length === 0, missing.join(', '))

  console.log('the shipped copy, in both hosts')
  let entryOut = ''
  let entryOk = true
  try {
    entryOut = execFileSync(process.execPath, [path.join(pkg, 'scripts', 'entry-check.mjs')], {
      cwd: pkg, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_PI_BRIDGE_HOME: path.join(pkg, '.tmp', '.entry-cache') },
    })
  } catch (e) {
    entryOk = false
    entryOut = String((e && e.stdout) || '') + String((e && e.stderr) || '')
  }
  const failed = (entryOut.match(/FAIL/g) || []).length
  if (!entryOk || failed) console.log(entryOut.trim().split('\n').map((l) => '  | ' + l).join('\n'))
  check('the extracted copy passes the entry check', entryOk && failed === 0, entryOk ? failed + ' FAIL lines' : 'nonzero exit')
  // Both halves must have been reached, not just the first: a missing
  // extensions/ or skills/ file would fail later than a DSH-only run gets.
  check('the DSH half loaded', /DSH tool registered: pi_install/.test(entryOut))
  check('the pi half loaded', /pi command registered: \/dsh-install/.test(entryOut))

  console.log('')
  console.log(failures ? failures + ' PACK CHECK(S) FAILED' : 'pack check passed: ' + shipped.size + ' files, both entries load')
} finally {
  if (KEEP) console.log('extraction kept at ' + tmp)
  else await rm(tmp, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
