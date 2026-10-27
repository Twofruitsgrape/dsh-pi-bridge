/**
 * Compose a DSH bundle the way DSH composes it: one row at a time.
 *
 * The official unit of a plugin is a row in `cordis.patch.yml`, not a package
 * entry point, so a bundle is loaded by walking its rows. Each row is mounted
 * with its own name, its own `config`, and its own `inject`; a row that disables
 * itself is reported rather than mounted, and a row naming a package outside the
 * bundle is an error rather than a silent fallback to the entry module.
 *
 * A bundle with no patch file yields one synthetic row pointing at the package
 * entry, which is the documented simple shape - so there is one code path, and
 * the common case is not special-cased into a different loader.
 *
 * @module src/compose.js
 */
import { captureDsh } from './capture.js'
import { dshEntry } from './manifest.js'
import { bundleRows, rowActivity, rowModulePath } from './patch-rows.js'

/**
 * @param {string} dir mirrored package root
 * @param {object} info classify() output (name, pkg)
 * @param {{compiled?: any, config?: any, log?: function, redirect?: function, capture?: function}} [options]
 * @returns {Promise<object>} one capture, as captureDsh returns it
 */
export async function composeBundle (dir, info, options = {}) {
  const log = options.log || (() => {})
  const redirect = options.redirect || ((file) => file)
  const capture = options.capture || captureDsh
  const pkg = (info && info.pkg) || {}
  const out = {
    capabilities: [],
    events: [],
    unsupported: [],
    errors: [],
    skillDirs: [],
    rows: [],
    notes: [],
  }

  const bundle = await bundleRows({ dir, pkg, log })
  out.notes.push(...bundle.notes)
  if (bundle.modifies.length) {
    // These address the host's own rows (system prompt, session titles, ...).
    // They are host configuration, not plugin capability, and pi has no
    // counterpart for them - reported so a reader knows they were seen, not
    // dropped.
    out.notes.push('patch also modifies host rows: ' + bundle.modifies.map((m) => m.id).join(', '))
  }
  const seenTools = new Set()
  if (!bundle.rows.length) {
    // A patch that declares no rows is a real shape (`[]`), and so is a package
    // that names a patch file but ships no rows yet. Falling back to the entry
    // module keeps such a package usable and says so, rather than reporting an
    // empty plugin for a file that simply had nothing to compose.
    const entry = await dshEntry(dir, pkg)
    if (!entry) {
      out.errors.push('bundle patch ' + (bundle.patch || '(none)') + ' composes no rows and the package has no entry module')
      return out
    }
    out.notes.push('patch ' + (bundle.patch || '(none)') + ' declares no rows; the package entry was composed instead')
    const one = await capture(redirect(entry, dir, options.compiled), (info && info.name) || '', configFor(pkg, null))
    out.rows.push({ id: '(entry)', mounted: true, origin: (info && info.name) || '' })
    merge(out, one, { id: '(entry)' }, seenTools)
    return out
  }

  for (const row of bundle.rows) {
    const activity = rowActivity(row)
    if (!activity.active) {
      out.rows.push({ id: row.id, mounted: false, reason: activity.reason })
      log('row ' + row.id + ' skipped: ' + activity.reason)
      continue
    }
    if (activity.reason) out.notes.push('row ' + row.id + ' ' + activity.reason)

    const target = rowModulePath(dir, pkg, row.name) || await dshEntry(dir, pkg)
    if (!target) {
      out.errors.push('row ' + row.id + ' names ' + row.name + ', which is not part of this package')
      out.rows.push({ id: row.id, mounted: false, reason: 'unresolvable name' })
      continue
    }

    const origin = row.name || (info && info.name) || row.id
    const config = row.config !== undefined
      ? row.config
      : configFor(pkg, row.id)
    const one = await capture(redirect(target, dir, options.compiled), origin, config)
    out.rows.push({ id: row.id, mounted: true, origin })
    merge(out, one, row, seenTools)
  }
  return out
}

/** A bundle's own manifest config still applies when a row carries none. */
function configFor (pkg, rowId) {
  const c = pkg && pkg.dsh && pkg.dsh.config
  if (!c || typeof c !== 'object') return {}
  const own = c[rowId]
  return own && typeof own === 'object' ? own : c
}

function merge (out, one, row, seenTools) {
  for (const cap of one.capabilities || []) {
    const key = cap.kind + ':' + cap.name
    if (cap.kind === 'tool' && seenTools.has(key)) {
      // Two rows exposing one tool name would collide in pi's registry; the
      // first row wins because row order carries no load semantics in DSH and
      // dropping both would lose a working tool.
      out.notes.push('row ' + row.id + ' repeats tool ' + cap.name + '; kept the first')
      continue
    }
    if (cap.kind === 'tool') seenTools.add(key)
    out.capabilities.push(cap)
  }
  out.events.push(...(one.events || []))
  out.skillDirs.push(...(one.skillDirs || []))
  for (const svc of one.unsupported || []) {
    const tag = 'inject:' + svc
    if (!out.unsupported.includes(tag)) out.unsupported.push(tag)
  }
  for (const e of one.errors || []) out.errors.push('row ' + row.id + ': ' + e)
  if (one.pluginName && !out.pluginName) out.pluginName = one.pluginName
}
