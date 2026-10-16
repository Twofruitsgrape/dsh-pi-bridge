/**
 * Fixture: a third-party-style DSH bundle.
 *
 * It bare-imports '@deepseek-ai/dsh-tools' exactly as a real plugin does, which is
 * the condition the runtime loader has to survive: a bundle linked into a profile
 * cannot resolve that specifier from its own location, and the loader rewrites it
 * to the running build's genuine module. Used by daemon/dsh-host-e2e.mjs (the
 * degraded path) and daemon/dsh-real-host.mjs (a real DSH session), and loaded by
 * a live host in daemon/dsh-proxy-e2e.mjs-style checks.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-hostload-fixture'
export const inject = ['tools']

export function apply (ctx) {
  ctx.tools.register(defineTool({
    name: 'hl_echo',
    description: 'Echo back, registered by a bundle that was loaded at runtime.',
    parameters: { text: { type: 'string', required: true, description: 'text to echo' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (a) => ({ ok: true, result: 'HOSTLOAD-RAN:' + a.text }),
  }))
}
