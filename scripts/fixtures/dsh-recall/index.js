/**
 * Fixture for reload behaviour: registers a tool and a command through the scope,
 * with no bare host imports, so the whole path runs under plain node.
 */
export const name = 'dsh-recall-fixture'
export const inject = ['tools']

export function apply (ctx) {
  ctx.tools.register({
    name: 'recall_echo',
    description: 'Echo back what was asked.',
    parameters: { text: { type: 'string', required: true, description: 'text' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (a) => ({ ok: true, result: 'RECALL-RAN:' + a.text }),
  })
  if (ctx.commands) ctx.commands.register({ name: 'recall-cmd', description: 'A command.', handler: async () => {} })
}
