/**
 * A tiny TypeBox-shaped and zod-shaped schema builder.
 *
 * Both hosts declare tool parameters with a schema builder: pi extensions use
 * typebox's Type.*, DSH plugins use schemastery's z.*. Under the bridge the
 * foreign package cannot resolve the host's real builder, so we hand it one
 * that produces plain JSON Schema - which is what both hosts ultimately want
 * (pi passes TypeBox straight through; dsh-tools compiles its spec map to
 * JSON Schema).
 *
 * Only the shaping calls appear in practice. Unknown builders return a
 * permissive {type:'json'} rather than throwing, so an unusual extension
 * still loads and its tool still registers.
 *
 * @module src/typebox-shim.js
 */

function schema (type, extra) {
  return { type, ...(extra || {}) }
}

/** @param {string} label name used in error text for unimplemented builders */
function permissive (label) {
  return schema('json', { bridgeOmit: label })
}

function build (kind) {
  const fn = (a, b) => {
    if (kind === 'object') {
      const properties = {}
      const required = []
      const src = a && typeof a === 'object' ? a : {}
      for (const [key, value] of Object.entries(src)) {
        if (!value || typeof value !== 'object') continue
        const optional = value.bridgeOptional === true
        const copy = { ...value }
        delete copy.bridgeOptional
        properties[key] = copy
        if (!optional && !('default' in copy)) required.push(key)
      }
      const out = schema('object', { properties, additionalProperties: b && b.additionalProperties === true })
      if (required.length) out.required = required
      if (b && typeof b.description === 'string') out.description = b.description
      return out
    }
    if (kind === 'string') return withMeta(schema('string', a && Array.isArray(a.enum) ? { enum: a.enum } : {}), a, b)
    if (kind === 'number' || kind === 'integer') return withMeta(schema(kind), a, b)
    if (kind === 'boolean') return schema('boolean')
    if (kind === 'array') return withMeta(schema('array', a ? { items: a } : { items: schema('json') }), null, b)
    if (kind === 'enum') return schema('string', { enum: Array.isArray(a) ? a : Object.values(a || {}) })
    if (kind === 'any' || kind === 'unknown' || kind === 'json') return permissive(kind)
    if (kind === 'null') return schema('null')
    return permissive(kind)
  }
  return fn
}

function withMeta (s, _a, b) {
  if (b && typeof b === 'object') {
    if (typeof b.description === 'string') s.description = b.description
    if (b.default !== undefined) s.default = b.default
    if (b.minimum !== undefined) s.minimum = b.minimum
    if (b.maximum !== undefined) s.maximum = b.maximum
    if (Array.isArray(b.enum)) s.enum = b.enum
  }
  return s
}

const NAMES = ['Object', 'String', 'Number', 'Integer', 'Boolean', 'Array', 'Enum', 'Any', 'Unknown', 'Null', 'Literal', 'Union', 'Optional', 'Required', 'Record', 'Ref', 'Schema']

/** typebox-shaped builder: Type.Object({ a: Type.String({ description }) }) */
export function createTypeShim () {
  const Type = {}
  for (const name of NAMES) {
    const kind = name.toLowerCase()
    Type[name] = (a, b) => {
      if (kind === 'optional') { const s = { ...(a && typeof a === 'object' ? a : {}) }; s.bridgeOptional = true; return s }
      if (kind === 'literal') return schema(typeof a === 'number' ? 'number' : 'string', { enum: [a] })
      if (kind === 'union') return schema('json', { oneOf: Array.isArray(a) ? a : [] })
      if (kind === 'record') return schema('object', { additionalProperties: true })
      return build(kind)(a, b)
    }
  }
  Type.Object = (a, b) => build('object')(a, b)
  // Unknown builders (Type.Unsafe, Type.TemplateLiteral, ...) must still be
  // callable: a bridged package then registers a permissive schema rather than
  // dying with "is not a function".
  return new Proxy(Type, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop !== 'string') return undefined
      return (...args) => permissive(prop)
    },
    has () { return true },
  })
}

/** schemastery/zod-shaped builder: z.object({ a: z.string().describe(...) }) */
export function createZShim () {
  const wrap = (s) => {
    const chain = (patch) => wrap({ ...s, ...(patch || {}) })
    return {
      ...s,
      __schema: s,
      describe: (description) => chain({ description }),
      optional: () => { const out = chain(); out.bridgeOptional = true; return out },
      default: (value) => chain({ default: value }),
      array: () => wrap({ type: 'array', items: s }),
      enum: () => s,
      min: (v) => chain({ minimum: v }),
      max: (v) => chain({ maximum: v }),
      parse: (v) => v,
      safeParse: (v) => ({ success: true, data: v }),
    }
  }
  const z = {
    object: (shape, opts) => wrap(build('object')(shape, opts)),
    string: () => wrap(schema('string')),
    number: () => wrap(schema('number')),
    boolean: () => wrap(schema('boolean')),
    literal: (v) => wrap(schema(typeof v === 'number' ? 'number' : 'string', { enum: [v] })),
    enum: (values) => wrap(schema('string', { enum: Array.isArray(values) ? values : Object.values(values || {}) })),
    array: (inner) => wrap({ type: 'array', items: inner && inner.__schema ? inner.__schema : schema('json') }),
    record: (inner) => wrap({ type: 'object', additionalProperties: inner && inner.__schema ? inner.__schema : true }),
    optional: (inner) => { const s = { ...(inner && inner.__schema ? inner.__schema : schema('json')) }; s.bridgeOptional = true; return wrap(s) },
    union: (list) => wrap(schema('json', { oneOf: (list || []).map(i => (i && i.__schema) || i) })),
    any: () => wrap(permissive('any')),
    unknown: () => wrap(permissive('unknown')),
    null: () => wrap(schema('null')),
  }
  return new Proxy(z, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop !== 'string') return undefined
      return () => wrap(permissive(prop))
    },
    has () { return true },
  })
}
