/**
 * The shape that killed a live DSH session, reduced to its essentials.
 *
 * npm:@michengai/dsh-automation reads `ctx.connection` and calls
 * `.rpc.handle(path, fn)`. That call runs inside the HOST's connection
 * implementation, which reads webServer off a fiber this deployment never
 * injected it into. The throw lands on the host's own registration path, in the
 * bundle's continuation - after apply() has already resolved - so the loader's
 * try/catch cannot see it and the host exits with "dsh: fatal load failure".
 *
 * This fixture reproduces it without a host: the throw is deferred by one tick,
 * exactly like the real bundle's continuation, and the scope's connection guard
 * is the only thing standing between it and an uncaught exception.
 */
export const name = 'connection-throw'
export const inject = ['tools']

export async function apply (ctx) {
  ctx.tools.register({
    name: 'connection_throw_tool',
    description: 'registered before the deferred connection call fails',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  })
  // Deferred on purpose: a synchronous throw here would be caught by the
  // loader's own apply() guard and would prove nothing about containment.
  setTimeout(() => {
    ctx.connection.rpc.handle('/dsh-fixture-boom', async () => ({ ok: true }))
  }, 0)
  await Promise.resolve()
}
