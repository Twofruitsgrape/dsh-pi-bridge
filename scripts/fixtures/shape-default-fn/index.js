/**
 * The shape npm:dsh-deja 0.23.1 publishes: no named `apply` at all, one default
 * export that happens to be a function named `apply`.
 *
 * `mod.apply || mod.default.apply` therefore evaluated to Function.prototype.apply
 * - a function, so every typeof check passed - and invoking it raised
 * "Function.prototype.apply was called on undefined, which is undefined and not a
 * function". The loader reported that as the bundle's own apply() failing.
 */
export const name = 'shape-default-fn'
export const inject = ['tools']

export default function apply (ctx) {
  ctx.tools.register({
    name: 'shape_default_fn_tool',
    description: 'registered by a default-exported apply function',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  })
}
