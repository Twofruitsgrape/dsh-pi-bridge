/**
 * Row 2: a subpath export. Its tool name carries the row's config, so a bridge
 * that mounts the package entry instead of the row, or that drops the row
 * config, produces an observable difference rather than a silent one.
 */
export const name = 'dsh-multi-row-fixture/extra'
export const inject = ['tools']

export function apply (ctx, config) {
  const greeting = (config && config.greeting) || 'no-config'
  ctx.tools.register({
    name: 'extra_tool_' + greeting.replace(/[^a-z0-9]+/gi, '_'),
    description: 'Registered by the subpath row, which was handed its own config.',
    parameters: { text: { type: 'string', required: true, description: 'Text' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute (args) { return 'extra:' + args.text },
  })
}
