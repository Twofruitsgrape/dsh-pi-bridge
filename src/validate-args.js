/**
 * Argument checks applied before a bridged tool runs, and the shape converters
 * both directions share.
 *
 * The bridge used to hand a caller's arguments straight to the package's
 * execute(), which is not what the receiving host does: pi validates against the
 * tool's own schema first. The difference is what a user reads - 'Cannot read
 * properties of undefined (reading trim)' from deep inside a package, versus
 * 'missing required key(s): prompt'. Same class of message as the package's own
 * validation, and the call stops before the package has to defend itself.
 *
 * Only checks a JSON Schema expresses without a full validator are made:
 * declared required keys, the top-level type of each provided property, and
 * unknown keys when additionalProperties is false. Coercion is deliberately not
 * attempted - rewriting a caller's arguments silently is the host's business, not
 * the bridge's.
 *
 * @module src/validate-args.js
 */
/**
 * @param {any} schema the tool's declared parameter schema
 * @param {any} args what the caller passed
 * @returns {string|null} a message when the call should not proceed
 */
export function validateArgs (schema, args) {
  if (!schema || typeof schema !== 'object') return null
  const props = schema.properties || {}
  const required = Array.isArray(schema.required) ? schema.required : []
  const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const missing = required.filter((k) => given[k] === undefined || given[k] === null)
  if (missing.length) return 'missing required key(s): ' + missing.join(', ')
  const wrong = []
  for (const [k, v] of Object.entries(given)) {
    const spec = props[k]
    if (!spec || typeof spec !== 'object' || !spec.type) continue
    if (v === undefined || v === null) continue
    const t = spec.type
    const ok = t === 'string' ? typeof v === 'string'
      : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : t === 'integer' ? typeof v === 'number' && Number.isInteger(v)
      : t === 'boolean' ? typeof v === 'boolean'
      : t === 'array' ? Array.isArray(v)
      : t === 'object' ? (typeof v === 'object' && !Array.isArray(v))
      : true
    if (!ok) wrong.push(k + ' expected ' + t + ', got ' + (Array.isArray(v) ? 'array' : typeof v))
  }
  if (wrong.length) return 'argument type mismatch: ' + wrong.join('; ')
  if (schema.additionalProperties === false) {
    const extra = Object.keys(given).filter((k) => !(k in props))
    if (extra.length) return 'unknown argument(s): ' + extra.join(', ')
  }
  return null
}

