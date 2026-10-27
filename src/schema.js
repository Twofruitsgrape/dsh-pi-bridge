/**
 * Parameter-schema bridge between the two host tool shapes, written against
 * each host's own type declarations rather than against examples.
 *
 * pi declares parameters as TypeBox / JSON Schema
 * (`{ type: "object", properties, required: [names] }`).
 * DSH declares a property map of `ValueSchemaSpec` nodes where requiredness is a
 * per-property `required: true`, and compiles it with
 * `parameterSchemaSpecToJsonSchema` from `@deepseek-ai/dsh-tools`.
 *
 * Two facts from that compiler decide the mapping:
 *   - an `object` node MUST carry `additionalProperties` as an explicit boolean;
 *     omitting it is a hard error ("unsupported JSON schema"), not a default.
 *   - DSH has `json` (any value) and `oneOf` (exact one) but no `anyOf`, and its
 *     `null` is a real type.
 *
 * What each side cannot express is degraded to the permissive `json` rather than
 * to something narrower: a bridged tool that registers loosely still works and
 * still shows descriptions, while a schema that claims a constraint the other
 * side cannot enforce would reject valid model output.
 *
 * @module src/schema.js
 */

/** Types both sides spell the same way. */
const SHARED = new Set(['string', 'number', 'integer', 'boolean', 'null'])

export function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

const annotate = (out, raw) => {
  for (const key of ['description', 'title', 'default']) {
    if (raw[key] !== undefined) out[key] = raw[key]
  }
  if (Array.isArray(raw.enum)) out.enum = raw.enum
  if (raw.const !== undefined) out.const = raw.const
  return out
}

/**
 * JSON Schema node -> DSH `ValueSchemaSpec`.
 *
 * @param {any} raw
 * @returns {object} a spec node
 */
export function jsonSchemaNodeToSpec (raw) {
  if (!isPlainObject(raw)) return { type: 'json' }

  // An empty schema means "any value" on both sides.
  const declared = Array.isArray(raw.type) ? raw.type : (raw.type ? [raw.type] : [])
  if (!declared.length) {
    if (Array.isArray(raw.oneOf)) {
      const branches = raw.oneOf.filter(isPlainObject).map(jsonSchemaNodeToSpec)
      if (branches.length >= 2) return annotate({ oneOf: branches }, raw)
    }
    // anyOf has no DSH spelling; union-by-type collapses to json when the types
    // are all json-safe anyway, which is what a model would accept either way.
    return annotate({ type: 'json' }, raw)
  }

  // A nullable scalar in TypeBox is a type array; DSH needs a oneOf branch.
  if (declared.length > 1) {
    const branches = declared.map((t) => ({ type: SHARED.has(t) ? t : 'json' }))
    if (branches.length >= 2) return annotate({ oneOf: branches }, raw)
  }

  const type = declared[0]
  if (SHARED.has(type)) return annotate({ type }, raw)
  if (type === 'array') return annotate({ type: 'array', items: isPlainObject(raw.items) ? jsonSchemaNodeToSpec(raw.items) : { type: 'json' } }, raw)
  if (type === 'object') {
    const spec = { type: 'object', properties: {}, additionalProperties: raw.additionalProperties !== false }
    const props = isPlainObject(raw.properties) ? raw.properties : {}
    for (const [key, node] of Object.entries(props)) {
      spec.properties[key] = jsonSchemaNodeToSpec(node)
      if (Array.isArray(raw.required) && raw.required.includes(key)) spec.properties[key].required = true
    }
    return annotate(spec, raw)
  }
  return annotate({ type: 'json' }, raw)
}

/**
 * DSH `ValueSchemaSpec` -> JSON Schema node.
 *
 * `json` becomes `{}` (any), the one spelling pi and TypeBox both read as
 * unconstrained; keeping a literal `type: "json"` would be a schema pi tolerates
 * by accident rather than by contract.
 *
 * @param {any} raw
 * @returns {object} a JSON Schema node
 */
export function specNodeToJsonSchema (raw) {
  if (!isPlainObject(raw)) return {}
  if (Array.isArray(raw.oneOf)) {
    const branches = raw.oneOf.filter(isPlainObject).map(specNodeToJsonSchema)
    if (branches.length >= 2) return annotate({ oneOf: branches }, raw)
  }
  const type = raw.type
  if (type === 'json' || type === undefined) return annotate({}, raw)
  if (SHARED.has(type)) return annotate({ type }, raw)
  if (type === 'array') {
    const node = { type: 'array' }
    if (isPlainObject(raw.items)) node.items = specNodeToJsonSchema(raw.items)
    return annotate(node, raw)
  }
  if (type === 'object') {
    const node = { type: 'object', properties: {} }
    const props = isPlainObject(raw.properties) ? raw.properties : {}
    const required = []
    for (const [key, child] of Object.entries(props)) {
      node.properties[key] = specNodeToJsonSchema(child)
      if (isPlainObject(child) && child.required === true) required.push(key)
    }
    if (required.length) node.required = required
    if (typeof raw.additionalProperties === 'boolean') node.additionalProperties = raw.additionalProperties
    return annotate(node, raw)
  }
  return annotate({}, raw)
}

/** JSON Schema object -> DSH property spec map. */
export function jsonSchemaToSpec (schema) {
  const out = {}
  if (!isPlainObject(schema)) return out
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const props = isPlainObject(schema.properties) ? schema.properties : {}
  for (const [key, raw] of Object.entries(props)) {
    const spec = jsonSchemaNodeToSpec(raw)
    delete spec.required
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
    const node = specNodeToJsonSchema(raw)
    delete node.required
    if (isPlainObject(raw) && (raw.required === true || typeof raw.required === 'string')) required.push(key)
    out.properties[key] = node
  }
  if (required.length) out.required = required
  return out
}

/** True when the value looks like a JSON Schema object rather than a spec map. */
export function looksLikeJsonSchema (v) {
  if (!isPlainObject(v)) return false
  // A spec map has no top-level `type` and no top-level `required`: requiredness
  // lives on each property there, and the required list is the object-level
  // spelling only JSON Schema has.
  if (v.type === 'object') return true
  if (Array.isArray(v.required)) return true
  if (isPlainObject(v.properties) && Array.isArray(v.oneOf)) return true
  return false
}

/** True when it looks like a DSH property spec map. */
export function looksLikeSpecMap (v) {
  if (!isPlainObject(v)) return false
  const keys = Object.keys(v)
  if (!keys.length) return true
  return keys.every(k => isPlainObject(v[k]) && (typeof v[k].type === 'string' || Array.isArray(v[k].oneOf)))
}

/** Normalize either family into a JSON Schema object (pi side). */
export function toToolSchema (params) {
  if (looksLikeJsonSchema(params)) return params
  if (isPlainObject(params) && Object.keys(params).length) return specToJsonSchema(params)
  return { type: 'object', properties: {} }
}

/** Normalize either family into a DSH property spec map (DSH side). */
export function toToolSpec (params) {
  if (looksLikeJsonSchema(params)) return jsonSchemaToSpec(params)
  if (isPlainObject(params)) return params
  return {}
}
