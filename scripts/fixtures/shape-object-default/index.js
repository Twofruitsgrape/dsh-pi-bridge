/**
 * The shape that already worked, kept as a regression guard: a default export
 * object carrying .apply and .inject. A fix that special-cases default-exported
 * functions must not break this one.
 */
export default {
  inject: ['tools'],
  apply (ctx) {
    ctx.tools.register({
      name: 'shape_object_default_tool',
      description: 'registered by a default-exported object plugin',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    })
  },
}
