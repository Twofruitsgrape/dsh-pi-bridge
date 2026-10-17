/**
 * Let a materialised bundle resolve its own name.
 *
 * Bundles split across packages depend on it: dsh-mnemon's providers each import
 * 'dsh-mnemon' and 'dsh-mnemon/contracts'. Installed by a plugin manager they sit
 * beside the parent, so Node's lookup walks up and finds it. The bridge cache
 * holds the package plus its dependencies only, so the name resolves to nothing
 * and the load dies on the first provider - which reads like a broken package but
 * is a difference in directory layout.
 *
 * The answer is a forwarding package inside the copy's node_modules. It cannot be
 * a symlink (an unprivileged process cannot create one on Windows: every
 * symlinkSync form, junction included, failed here) and it cannot re-export
 * through package.json "exports", because Node rejects a target that climbs out
 * of the package (ERR_INVALID_PACKAGE_TARGET, measured) and rejects a file: URL
 * target there too. So each export key gets a real file in the forwarding package
 * whose import statement climbs out: relative specifiers inside module code are
 * not restricted the way exports targets are. The climb lands on the parent's own
 * files, so a bundle that imports itself shares one module instance with the copy
 * the host loads, rather than a second copy with its own state.
 *
 * @module src/self-ref.js
 */
import { mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises'
import path from 'node:path'

/** Pick the condition a runtime loader would take from an exports value. */
function pickTarget (value) {
  if (!value) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const v of value) { const t = pickTarget(v); if (t) return t }
    return null
  }
  for (const key of ['import', 'default', 'require', 'node']) {
    if (value[key]) { const t = pickTarget(value[key]); if (t) return t }
  }
  return null
}

function safeName (key) {
  return key.replace(/^\.\/|^\/|^\.\/\//, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'index'
}

/**
 * Write the forwarding package.
 *
 * @param {string} dir the materialised package root
 * @param {(m:string)=>void} [log]
 * @returns {Promise<{written:boolean, keys:string[], reason?:string}>}
 */
export async function ensureSelfReference (dir, log) {
  const note = log || (() => {})
  let pkg = null
  try { pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) } catch { return { written: false, keys: [], reason: 'no package.json' } }
  if (!pkg || !pkg.name) return { written: false, keys: [], reason: 'no name' }

  const parts = String(pkg.name).split('/')
  const link = path.join(dir, 'node_modules', ...parts)
  // A copy that already carries the real package (a plugin-manager layout) needs
  // nothing; overwriting it would replace the genuine thing with a stub.
  try {
    const inner = JSON.parse(await readFile(path.join(link, 'package.json'), 'utf8'))
    if (inner.name === pkg.name && (inner.main || inner.exports)) return { written: false, keys: [], reason: 'already resolvable' }
  } catch { /* absent or a leftover forwarder: rebuild */ }

  // From <dir>/node_modules/[<scope>/]<name>/ back up to <dir>.
  const climb = parts.length === 2 ? '../../..' : '../..'
  const esm = pkg.type === 'module'

  // Export keys the parent publishes. Wildcard keys are expanded against the real
  // directory so a provider importing a generated name still resolves.
  const keys = new Map()
  const exports = pkg.exports
  if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
    for (const [key, value] of Object.entries(exports)) {
      if (key === './package.json') continue
      if (key.endsWith('/*')) {
        const target = pickTarget(value)
        if (!target || !target.endsWith('/*')) continue
        const base = key.slice(2, -2)
        const fileBase = target.slice(2, -2)
        let names = []
        try { names = await readdir(path.join(dir, fileBase)) } catch { continue }
        for (const n of names) {
          if (!/\.(mjs|cjs|js)$/.test(n) || n.endsWith('.map')) continue
          keys.set(base ? base + '/' + n.replace(/\.(mjs|cjs|js)$/, '') : n.replace(/\.(mjs|cjs|js)$/, ''), fileBase + '/' + n)
        }
        continue
      }
      const t = pickTarget(value)
      // A key that only points at itself (package.json) is not an import surface.
      if (t) keys.set(key === '.' ? '' : key.replace(/^\.\//, ''), t.replace(/^\.\//, ''))
    }
  } else if (pkg.main) {
    keys.set('', String(pkg.main).replace(/^\.\//, ''))
  }
  if (!keys.size) return { written: false, keys: [], reason: 'no import surface to forward' }

  await rm(link, { recursive: true, force: true }).catch(() => {})
  await mkdir(link, { recursive: true })

  const shimExports = {}
  const written = []
  for (const [key, relTarget] of keys) {
    const name = key === '' ? 'index' : safeName(key)
    const file = name + (esm ? '.mjs' : '.cjs')
    const target = climb + '/' + relTarget.split(path.sep).join('/')
    let body
    if (esm) {
      // export * skips a default export, so re-export it when the parent has one.
      let hasDefault = false
      try { hasDefault = /\bexport\s+default\b/.test(await readFile(path.join(dir, relTarget), 'utf8')) } catch { /* missing target */ }
      body = 'export * from ' + JSON.stringify(target) + '\n' + (hasDefault ? 'export { default } from ' + JSON.stringify(target) + '\n' : '')
    } else {
      body = 'module.exports = require(' + JSON.stringify(target) + ')\n'
    }
    try {
      await writeFile(path.join(link, file), body, 'utf8')
    } catch (e) {
      return { written: false, keys: [], reason: 'write failed: ' + String((e && e.code) || e) }
    }
    // No "types" entry: nothing here is a declaration file, and pointing at a
    // missing one makes a TypeScript consumer fail instead of simply reading the
    // JavaScript next door.
    shimExports[key === '' ? '.' : './' + key] = esm
      ? { import: './' + file, default: './' + file }
      : { require: './' + file, default: './' + file }
    written.push(key === '' ? pkg.name : pkg.name + '/' + key)
  }
  const shimPkg = {
    name: pkg.name,
    version: pkg.version || '0.0.0',
    description: 'Bridge forwarding package: resolves to the real files in the parent bundle.',
  }
  if (esm) shimPkg.type = 'module'
  shimPkg.exports = shimExports
  await writeFile(path.join(link, 'package.json'), JSON.stringify(shimPkg, null, 2) + '\n', 'utf8')
  note('self-reference written for ' + pkg.name + ' (' + written.length + ' entry points)')
  return { written: true, keys: written }
}

/** True when the directory looks like it already resolves its own name. */
export async function resolvableByItself (dir) {
  let pkg = null
  try { pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) } catch { return false }
  if (!pkg || !pkg.name) return false
  try { await stat(path.join(dir, 'node_modules', ...pkg.name.split('/'), 'package.json')); return true } catch { return false }
}
