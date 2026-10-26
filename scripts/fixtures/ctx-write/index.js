/**
 * A bundle that keeps its own state on the context object.
 *
 * npm:dsh-remote-mobile's apply() opens with
 * `ctx.__dsh_rm_index_mounted__ = true` as an idempotency flag. The scope's set
 * trap refused every write, and ESM bundles run in strict mode, so that
 * assignment raised "'set' on proxy: trap returned falsish" and the whole bundle
 * failed - over a private flag the host never needed to see.
 */
export const name = 'ctx-write'
export const inject = ['tools']

export async function apply (ctx) {
  ctx.__dsh_fixture_mounted__ = true
  if (ctx.__dsh_fixture_mounted__ !== true) throw new Error('the write did not stick')
  ctx.tools.register({
    name: 'ctx_write_tool',
    description: 'registered after writing a private flag on ctx',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  })
}
