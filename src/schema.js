/**
 * Parameter-schema bridge between the two host tool shapes.
 *
 * pi declares parameters as a TypeBox / JSON Schema object
 * ({ type: "object", properties, required: [names] }).
 * DSH declares a property spec map ({ name: { type, description,
 * required: true } }) that dsh-tools compiles to JSON Schema itself.
 *
 * Both directions are pure data transforms. An unrecognized shape degrades to
 * the permissive "json" type instead of throwing: a bridged tool that registers
 * loosely still works, and the model still gets the descriptions it needs.
 *
 * @module src/schema.js
 */

const SCALAR = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'json'])

export function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** JSON Schema object -> DSH property spec map. */
export function jsonSchemaToSpec (schema) {
  const out = {}
  if (!isPlainObject(schema)) return out
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const props = isPlainObject(schema.properties) ? schema.properties : {}
  for (const [key, raw] of Object.entries(props)) {
    if (!isPlainObject(raw)) { out[key] = { type: 'json' }; continue }
    const spec = {}
    const t = Array.isArray(raw.type) ? raw.type[0] : raw.type
    spec.type = SCALAR.has(t) ? t : 'json'
    if (typeof raw.description === 'string') spec.description = raw.description
    if (Array.isArray(raw.enum)) spec.enum = raw.enum
    if (raw.default !== undefined) spec.default = raw.default
    if (spec.type === 'array') {
      const items = isPlainObject(raw.items) ? raw.items : {}
      spec.items = { type: SCALAR.has(items.type) ? items.type : 'json' }
      if (Array.isArray(items.enum)) spec.items.enum = items.enum
    }
    if (spec.type === 'object' && isPlainObject(raw.properties)) {
      spec.properties = jsonSchemaToSpec(raw)
    }
    if (required.has(key)) spec.required = true
    out[key] = spec
  }
  return out
}

/** DSH property spec map -> JSON Schema object. */
export function specToJsonSchema (map) {
  const out = { type: 'object', properties: {} }
  const required = []
  if (!isPlainObject(map)) return out
  for (const [key, raw] of Object.entries(map)) {
    const prop = isPlainObject(raw) ? { ...raw } : { type: 'json' }
    if (!SCALAR.has(prop.type)) prop.type = 'json'
    if (prop.type === 'object' && isPlainObject(raw.properties)) {
      const nested = specToJsonSchema(raw.properties)
      prop.properties = nested.properties
      if (nested.required) prop.required = nested.required
    }
    if (raw && (raw.required === true || typeof raw.required === 'string')) required.push(key)
    out.properties[key] = prop
  }
  if (required.length) out.required = required
  return out
}

/** True when the value looks like a JSON Schema object rather than a spec map. */
export function looksLikeJsonSchema (v) {
  return isPlainObject(v) && (v.type === 'object' || (isPlainObject(v.properties) && Object.keys(v.properties).some(k => isPlainObject(v.properties[k]) && ('type' in v.properties[k] || 'description' in v.properties[k]))))
}

/** True when it looks like a DSH property spec map. */
export function looksLikeSpecMap (v) {
  if (!isPlainObject(v)) return false
  const keys = Object.keys(v)
  if (!keys.length) return true
  return keys.every(k => isPlainObject(v[k]) && typeof v[k].type === 'string')
}

/** Normalize either family into a JSON Schema object (pi side). */
export function toToolSchema (params) {
  if (looksLikeJsonSchema(params)) return params
  if (isPlainObject(params)) return specToJsonSchema(params)
  return { type: 'object', properties: {} }
}

/** Normalize either family into a DSH property spec map (DSH side). */
export function toToolSpec (params) {
  if (looksLikeSpecMap(params)) return params
  if (isPlainObject(params)) return jsonSchemaToSpec(params)
  return {}
}
