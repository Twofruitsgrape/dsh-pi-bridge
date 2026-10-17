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
  // A bounded slow tool. It exists so a test can hold a live DSH session open on
  // a real tool call rather than on a sleep the harness hopes to time correctly,
  // and it exercises the forwarding path with a long-running call: pi waits for
  // the result instead of giving up at a fixed timeout.
  ctx.tools.register(defineTool({
    name: 'hl_hold',
    description: 'Wait for a bounded number of milliseconds, then confirm.',
    parameters: { ms: { type: 'number', required: true, description: 'milliseconds to wait' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (a) => {
      const ms = Math.max(0, Math.min(Number(a.ms) || 0, 300000))
      await new Promise((r) => setTimeout(r, ms))
      return { ok: true, result: 'HELD-' + ms }
    },
  }))
  // Deferred registration through the host's own injection hook: real bundles
  // (dsh-gitbash-shell, dsh-thinking-levels) register this way, waiting for a
  // service to appear. A loader that only observes the scope it hands out misses
  // these entirely - the tool exists in the host yet nothing can reach it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (inner) => {
      // A slash command registered from the same deferred callback: whether the
      // report sees these is a separate question from tools, and the two paths
      // disagreed on a live run (dsh_install listed /agent-teams, /load listed
      // nothing for the same bundle).
      if (inner.commands && typeof inner.commands.register === 'function') {
        inner.commands.register({ name: 'hl-cmd-deferred', description: 'Deferred command.', handler: async () => {} })
      }
      inner.tools.register(defineTool({
        name: 'hl_deferred',
        description: 'Registered from inside a deferred ctx.inject callback.',
        parameters: { text: { type: 'string', required: true, description: 'text' } },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
          render: (_a, v) => [{ type: 'text', text: v.result }],
        },
        execute: async (a) => ({ ok: true, result: 'DEFERRED-RAN:' + a.text }),
      }))
    })
  }
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
