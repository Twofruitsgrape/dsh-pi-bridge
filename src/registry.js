/**
 * The shared bridge registry, ~/.dsh-pi-bridge/bridges.json.
 *
 * Several plugin instances read and write this one file: the DSH root instance,
 * per-agent realms that mount the same plugin, and the pi side. A writer therefore
 * changes only the keys it means to change and merges them over the newest copy on
 * disk. Writing a whole in-memory map back resurrects entries another writer
 * removed; measured on a live session, bridge_remove forgot two bridges and the
 * file came back with three that an earlier boot had loaded.
 *
 * A file that exists but does not parse is refused rather than overwritten, since
 * overwriting it would silently drop every entry the user recorded.
 *
 * @module src/registry.js
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * @param {string} file
 * @returns {Promise<{bridges: Record<string, any>}>} an empty registry when absent or unreadable
 */
export async function readRegistry (file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return { bridges: {} } }
}

/**
 * @param {string} file
 * @param {{upserts?: Record<string, any>, removed?: string[]}} [change]
 * @returns {Promise<Record<string, any>>} the bridges map as it now stands on disk
 * @throws when the file exists but is not valid JSON; it is left untouched
 */
export async function updateRegistry (file, change = {}) {
  const upserts = change.upserts || {}
  const removed = change.removed || []
  await mkdir(path.dirname(file), { recursive: true })
  let current = { bridges: {} }
  let text = null
  try { text = await readFile(file, 'utf8') } catch { /* absent: first write */ }
  if (text !== null) {
    try { current = JSON.parse(text) } catch (e) {
      throw new Error('bridge registry ' + file + ' is not valid JSON; refusing to overwrite it (' + String((e && e.message) || e).slice(0, 80) + ')')
    }
  }
  current.bridges = current.bridges || {}
  for (const [key, value] of Object.entries(upserts)) current.bridges[key] = value
  for (const key of removed) delete current.bridges[key]
  await writeFile(file, JSON.stringify(current, null, 2), 'utf8')
  return current.bridges
}
