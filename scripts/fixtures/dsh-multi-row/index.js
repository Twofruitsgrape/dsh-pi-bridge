/** Row 1: the package entry, reached by the root row name. */
export const name = 'dsh-multi-row-fixture'
export const inject = ['tools']

export function apply (ctx) {
  ctx.tools.register({
    name: 'root_tool',
    description: 'Registered by the bundle root row.',
    parameters: { text: { type: 'string', required: true, description: 'Text' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute (args) { return 'root:' + args.text },
  })
}
