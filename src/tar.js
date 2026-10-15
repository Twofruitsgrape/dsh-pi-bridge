/**
 * Minimal gzipped-tar reader: exactly enough to unpack an npm tarball, which
 * is the only archive this bridge downloads. npm tarballs carry one top-level
 * directory (always "package/") that is stripped here.
 *
 * Directory entries and plain files only; links, pax headers and hard links
 * are skipped rather than mistaken for content. Entries escaping the target
 * directory are dropped.
 *
 * @module src/tar.js
 */
import { gunzipSync } from 'node:zlib'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'

const BLOCK = 512
const NAME_OFFSET = 0
const NAME_LENGTH = 100
const SIZE_OFFSET = 124
const SIZE_LENGTH = 12
const TYPE_OFFSET = 156

/**
 * @param {string} tgzPath archive to read
 * @param {string} destDir absolute directory to unpack into
 * @returns {Promise<string[]>} files written
 */
export async function extractTgz (tgzPath, destDir) {
  const buf = gunzipSync(await readFile(tgzPath))
  const target = path.resolve(destDir)
  const written = []
  let offset = 0
  while (offset + BLOCK <= buf.length) {
    const name = buf.toString('utf8', offset + NAME_OFFSET, offset + NAME_OFFSET + NAME_LENGTH).replace(/\0[\s\S]*$/, '')
    if (name === '') break
    const rawSize = buf.toString('ascii', offset + SIZE_OFFSET, offset + SIZE_OFFSET + SIZE_LENGTH).replace(/\0[\s\S]*$/, '').trim()
    const size = Number.parseInt(rawSize, 8)
    const type = String.fromCharCode(buf[offset + TYPE_OFFSET] ?? 48)
    offset += BLOCK
    if (!Number.isFinite(size) || size < 0) break
    const dataStart = offset
    const dataEnd = Math.min(offset + size, buf.length)
    offset += Math.ceil(size / BLOCK) * BLOCK
    if (type !== '0' && type !== '\0' && type !== '5') continue
    const rel = name.replace(/^[^/]+\//, '')
    if (!rel) continue
    const full = path.resolve(target, rel)
    if (full !== target && !full.startsWith(target + path.sep)) continue
    if (type === '5') { await mkdir(full, { recursive: true }); continue }
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, buf.subarray(dataStart, dataEnd))
    written.push(full)
  }
  return written
}
