/**
 * The real cause of the fatal load failure, isolated from the package that
 * exposed it.
 *
 * npm:@michengai/dsh-automation runs its whole activation inside
 * `ctx.effect(async () => { ... })`. The scope's effect shim called the factory
 * and dropped the promise it returned. Nothing awaited that promise, so when the
 * host's connection layer threw inside it the rejection was unowned - and node
 * terminates the process on an unhandled rejection. The host printed
 * "dsh: fatal load failure: Error: cannot get property "webServer" without
 * inject", whose stack named the throw site rather than the reason it escaped.
 *
 * This fixture rejects from an async effect factory with no host involved, so
 * the escape is provable offline.
 */
export const name = 'effect-reject'
export const inject = ['tools']

export async function apply (ctx) {
  ctx.tools.register({
    name: 'effect_reject_tool',
    description: 'registered before the effect factory rejects',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  })
  ctx.effect(async () => {
    await Promise.resolve()
    throw new Error('EFFECT FACTORY REJECTED ON PURPOSE')
  }, 'fixture effect')
}
