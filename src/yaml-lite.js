/**
 * A block-YAML reader for the subset `cordis.patch.yml` files actually use.
 *
 * Deliberately not a general YAML parser. The measurement that set the scope:
 * across the 20 patch files shipped in DSH 0.2.1-rc.2 the only constructs are
 * block sequences, block mappings, flow sequences (`inject: [a, b]`), plain and
 * quoted scalars, and block scalars (`>-`, `|`). No anchors, no tags, no
 * multi-document streams, no flow mappings.
 *
 * Where it cannot follow, it records a note instead of throwing or guessing.
 * A patch we only partly understood must still be reportable as such - silently
 * returning a smaller structure is how a plugin ends up looking empty.
 *
 * @module src/yaml-lite.js
 */

/**
 * @typedef {{ value: any, notes: string[] }} ParsedYaml
 */

/** Blank, comment-only, or document-marker line. */
function isSkippable (line) {
  const t = line.trim()
  return t === '' || t.startsWith('#') || t === '---' || t === '...'
}

/** Indentation width; tabs are not legal YAML indentation and are reported. */
function indentOf (line, notes, lineNo) {
  const m = /^[ \t]*/.exec(line)[0]
  if (m.includes('\t')) notes.push('line ' + lineNo + ': tab in indentation')
  return m.length
}

/** Strip an unquoted trailing comment. Quotes are respected. */
function stripComment (text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#' && (i === 0 || text[i - 1] === ' ')) return text.slice(0, i)
  }
  return text
}

/** A scalar as YAML would type it. */
function scalar (raw) {
  const t = raw.trim()
  if (t === '') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null' || t === '~') return null
  if (/^-?\d+$/.test(t)) return Number(t)
  if (/^-?\d*\.\d+$/.test(t)) return Number(t)
  if (t.startsWith('"') && t.endsWith('"') && t.length > 1) {
    try { return JSON.parse(t) } catch { return t.slice(1, -1) }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

/** `[a, b, 'c']` -> ['a','b','c']; anything else returns undefined. */
function flowSeq (text) {
  const t = text.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return undefined
  const inner = t.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map((p) => scalar(p))
}

/** Split `key: value` at the first top-level colon; null when there is none. */
function splitKey (text) {
  let quote = null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === ':' && depth === 0) {
      const after = text[i + 1]
      if (after === undefined || after === ' ') return [text.slice(0, i).trim(), text.slice(i + 1)]
    }
  }
  return null
}

/**
 * Parse a YAML document into plain JS values.
 * @param {string} text
 * @returns {ParsedYaml}
 */
export function parseYaml (text) {
  const notes = []
  const lines = String(text == null ? '' : text).split(/\r?\n/)
    .map((raw, i) => ({ raw, lineNo: i + 1 }))
    .filter((l) => !isSkippable(l.raw))
  let i = 0

  /** Block scalar body: every following line indented deeper than the owner. */
  function blockScalar (parentIndent, folded) {
    const collected = []
    while (i < lines.length && indentOf(lines[i].raw, notes, lines[i].lineNo) > parentIndent) {
      collected.push(lines[i].raw.trim())
      i++
    }
    return folded ? collected.join(' ') : collected.join('\n')
  }

  function parseNode (indent) {
    if (i >= lines.length) return null
    const first = lines[i]
    const at = indentOf(first.raw, notes, first.lineNo)
    if (at < indent) return null
    const body = first.raw.trim()
    if (body.startsWith('- ') || body === '-') return parseSeq(at)
    return parseMap(at)
  }

  function parseSeq (indent) {
    const out = []
    while (i < lines.length) {
      const line = lines[i]
      const at = indentOf(line.raw, notes, line.lineNo)
      if (at !== indent) break
      const body = stripComment(line.raw.trim())
      if (!(body.startsWith('- ') || body === '-')) break
      const rest = body.slice(1).trim()
      i++
      if (rest === '') {
        out.push(parseNode(indent + 1))
        continue
      }
      const kv = splitKey(rest)
      if (!kv) { out.push(scalar(rest)); continue }
      // `- key: value` opens a mapping whose remaining keys sit two columns in.
      const item = {}
      assignKey(item, kv[0], kv[1], indent + 2)
      while (i < lines.length) {
        const nxt = lines[i]
        const nat = indentOf(nxt.raw, notes, nxt.lineNo)
        if (nat !== indent + 2) break
        const nbody = stripComment(nxt.raw.trim())
        if (nbody.startsWith('- ')) break
        const nkv = splitKey(nbody)
        if (!nkv) { notes.push('line ' + nxt.lineNo + ': expected a key'); i++; continue }
        i++
        assignKey(item, nkv[0], nkv[1], indent + 2)
      }
      out.push(item)
    }
    return out
  }

  function parseMap (indent) {
    const out = {}
    while (i < lines.length) {
      const line = lines[i]
      const at = indentOf(line.raw, notes, line.lineNo)
      if (at !== indent) break
      const body = stripComment(line.raw.trim())
      if (body.startsWith('- ')) break
      const kv = splitKey(body)
      if (!kv) { notes.push('line ' + line.lineNo + ': expected a key'); i++; continue }
      i++
      assignKey(out, kv[0], kv[1], indent)
    }
    return out
  }

  function assignKey (target, key, restRaw, ownIndent) {
    const rest = (restRaw || '').trim()
    if (rest === '') {
      const child = (i < lines.length && indentOf(lines[i].raw, notes, lines[i].lineNo) > ownIndent)
        ? parseNode(indentOf(lines[i].raw, notes, lines[i].lineNo))
        : null
      target[key] = child
      return
    }
    if (/^[>|][+-]?$/.test(rest)) {
      target[key] = blockScalar(ownIndent, rest.startsWith('>'))
      return
    }
    const seq = flowSeq(rest)
    target[key] = seq !== undefined ? seq : scalar(rest)
  }

  const root = parseNode(0)
  if (i < lines.length) notes.push('line ' + lines[i].lineNo + ': trailing content not parsed')
  return { value: root, notes }
}
