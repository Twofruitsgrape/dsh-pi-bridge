/**
 * The unit of a DSH plugin is a row, not a package.
 *
 * `dsh.bundle.patch` names a `cordis.patch.yml` whose role is to compose plugin
 * rows into a profile. Measured over the 18 patch files shipped in
 * DSH 0.2.1-rc.2: 250 inserted rows, of which 70 carry a `config`, 7 declare
 * `inject` on the row, 18 disable themselves with a `!!js` expression, and 6
 * name a *subpath* (`@deepseek-ai/dsh-plugin-manager/tools`, six such names in
 * four packages) rather than the package root.
 *
 * That is why loading `main` and calling it a plugin is wrong for the official
 * format: it silently ignores every row but one, resolves the wrong module
 * whenever the row names a subpath, and neither honours `config` nor reports a
 * row that an expression keeps out.
 *
 * Only two top-level operations exist in the whole distribution - `insert` and
 * `- id` (modify an existing row). Modify operations target the host's own rows
 * (`system-prompt`, `session-title-llm`) and describe host configuration that pi
 * has no counterpart for, so they are reported rather than translated.
 *
 * @module src/patch-rows.js
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseYaml } from './yaml-lite.js'

/** Where a package declares its patch file. */
export function bundlePatch (pkg) {
  const b = pkg && pkg.dsh && pkg.dsh.bundle
  if (!b) return null
  if (typeof b === 'string') return b
  return b.patch || null
}

/**
 * Whether a row should be composed.
 *
 * `true` is a decision and is honoured. A `!!js` expression is not a decision we
 * can read: it selects a host profile (`!ctx.get('profileContext')`) or a
 * platform, not the user's intent, and the user asked for this plugin. Such a
 * row is composed and reported, never dropped in silence.
 *
 * @param {any} row
 * @returns {{active: boolean, reason: string|null}}
 */
export function rowActivity (row) {
  if (!row || row.disabled === undefined) return { active: true, reason: null }
  if (row.disabled === true) return { active: false, reason: 'disabled: true in the bundle patch' }
  if (row.disabled === false) return { active: true, reason: null }
  return { active: true, reason: 'conditional: ' + String(row.disabled) }
}

/**
 * Resolve one row's module inside its package.
 *
 * A row name is a package name, optionally with a subpath. The root name is the
 * package's own entry; a subpath follows the package `exports` map first, then
 * the literal path, because a bundle that publishes `./tools` means that file.
 *
 * @param {string} dir package root
 * @param {object} pkg its manifest
 * @param {string|undefined} name row name
 * @returns {string|null} absolute file, or null when it is not this package
 */
export function rowModulePath (dir, pkg, name) {
  const pkgName = (pkg && pkg.name) || ''
  if (!name) return null
  const sub = pkgName && name.startsWith(pkgName + '/') ? name.slice(pkgName.length + 1) : null
  if (name !== pkgName && !sub) return null
  if (!sub) return null
  const exp = pkg && pkg.exports && pkg.exports['./' + sub]
  const fromExports = typeof exp === 'string'
    ? exp
    : (exp && (exp.default || exp.import || exp.node))
  return path.join(dir, fromExports || sub)
}

/**
 * Parse a bundle's patch into composable rows plus everything it does that this
 * bridge does not translate.
 *
 * @param {string} text patch file contents
 * @returns {{rows: object[], modifies: object[], notes: string[]}}
 */
export function parsePatch (text) {
  const parsed = parseYaml(text)
  const notes = [...parsed.notes]
  const rows = []
  const modifies = []
  const ops = Array.isArray(parsed.value) ? parsed.value : (parsed.value ? [parsed.value] : [])

  for (const op of ops) {
    if (!op || typeof op !== 'object') { notes.push('patch entry is not a mapping'); continue }
    if (Array.isArray(op.insert)) {
      for (const row of op.insert) {
        if (!row || typeof row !== 'object' || !row.id) { notes.push('insert row without an id'); continue }
        rows.push({
          id: String(row.id),
          name: row.name ? String(row.name) : undefined,
          inject: normaliseInject(row.inject),
          config: row.config,
          disabled: row.disabled,
        })
      }
      continue
    }
    if (op.id) {
      modifies.push({ id: String(op.id), keys: Object.keys(op).filter((k) => k !== 'id') })
      continue
    }
    notes.push('unknown patch operation: ' + Object.keys(op).join(', '))
  }
  return { rows, modifies, notes }
}

/** `inject` is a flow list, a block list, or a lone scalar. */
export function normaliseInject (v) {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

/**
 * Read a package's declared patch and turn it into the rows to compose.
 *
 * A package with no patch file is not an error: the documented simple shape is a
 * bundle whose single row is the package itself. It yields one synthetic row so
 * the caller has one code path.
 *
 * @param {{dir: string, pkg: object, log?: function}} input
 * @returns {Promise<{rows: object[], modifies: object[], notes: string[], patch: string|null}>}
 */
export async function bundleRows ({ dir, pkg, log }) {
  const rel = bundlePatch(pkg)
  const emit = log || (() => {})
  if (!rel) {
    emit('no dsh.bundle.patch; treating the package entry as one plugin')
    return { rows: [{ id: pkg && pkg.name, name: pkg && pkg.name, inject: [], config: undefined }], modifies: [], notes: [], patch: null }
  }
  let text
  try { text = await readFile(path.join(dir, rel), 'utf8') } catch (e) {
    return { rows: [], modifies: [], notes: ['declared patch ' + rel + ' could not be read: ' + (e && e.code)], patch: rel }
  }
  const parsed = parsePatch(text)
  return { ...parsed, patch: rel }
}
