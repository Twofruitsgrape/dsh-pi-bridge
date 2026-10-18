/**
 * A bundle that registers one tool and then rejects. This is the shape that
 * killed a live DSH session: detached-scope called the inject callback and dropped
 * the promise an async apply returned, so the rejection was never awaited by
 * anyone, and node terminates on an unhandled rejection. The host printed "dsh:
 * fatal load failure" and died, taking the six loads still queued behind it.
 *
 * It also exposes the retry loop double-registering: the first attempt ran (so
 * the tool was registered), threw, and the loop tried again with a narrower list.
 */
export const name = 'async-reject'
export const inject = ['tools']
export async function apply (ctx) {
  ctx.tools.register({ name: 'ar_tool', description: 'registered before rejecting',
    parameters: { q: { type: 'string', description: 'x' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
      render: (a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async () => ({ ok: true, result: "ok" }),
  })
  await Promise.resolve()
  throw new Error('FIXTURE REJECTED ON PURPOSE')
}
