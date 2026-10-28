/**
 * Replay captured DSH capabilities into a real pi ExtensionAPI.
 *
 * pi tools take a TypeBox-shaped parameter schema (plain JSON Schema is the
 * same thing) and answer { content, details }; slash commands take a name plus
 * { description, handler }; skills are contributed by answering the
 * resources_discover event with skillPaths, which is how an extension adds a
 * skill directory it owns.
 *
 * DSH-only capabilities (model providers, host web routes, UI slots) have no pi
 * counterpart: they are reported, not dropped in silence.
 *
 * @module src/replay-pi.js
 */
import { mapEvent } from './capabilities.js'

/**
 * @param {any} pi pi ExtensionAPI
 * @param {any} captured result of captureDsh
 * @param {{prefix?: string}} [options]
 * @returns {{tools:string[],commands:string[],skills:string[],events:string[],skipped:string[]}}
 */
export function replayIntoPi (pi, captured, options) {
  const prefix = (options && options.prefix) || ''
  const report = { tools: [], commands: [], skills: [], events: [], skipped: [] }
  const skillDirs = []

  for (const cap of captured.capabilities || []) {
    const name = prefix ? prefix + '_' + cap.name : cap.name
    if (cap.kind === 'tool') {
      try {
        pi.registerTool({
          name,
          label: cap.label || name,
          description: (cap.description || '(no description)') + ' [bridged by dsh-pi-bridge from ' + (cap.origin || 'dsh') + ']',
          promptSnippet: cap.description ? String(cap.description).slice(0, 120) : undefined,
          parameters: cap.schema,
          // Declared only when the source declared one: pi uses it to hand
          // programmatic callers structured data instead of prose.
          outputSchema: cap.outputSchema,
          // The bundle asked for deferred loading; keeping it undeclared would
          // put every tool of a large bundle into the model's context.
          exposure: cap.deferred ? 'deferred' : undefined,
          // The bundle ships a per-call concurrency classifier. pi's execution
          // mode is static, so the only claim that is always true is the
          // conservative one: run one at a time.
          executionMode: cap.sequentialOnly ? 'sequential' : undefined,
          async execute (_toolCallId, params, signal, _onUpdate, ctx) {
            const out = await cap.run(params, { signal, ctx })
            const result = {
              content: [{ type: 'text', text: out.text || JSON.stringify(out.structured === undefined ? null : out.structured) }, ...out.images],
              details: { bridge: true, origin: cap.origin, name, timeoutMs: cap.timeoutMs },
            }
            if (cap.outputSchema && out.structured !== undefined && out.structured !== null) result.structuredContent = out.structured
            return result
          },
        })
        report.tools.push(name)
      } catch (e) {
        report.skipped.push('tool ' + name + ': ' + shortMessage(e))
      }
      continue
    }
    if (cap.kind === 'command') {
      try {
        pi.registerCommand(name, {
          description: (cap.description || '') + ' [dsh-pi-bridge]',
          handler: async (input, ctx) => {
            const out = await cap.run(String(input || ''), ctx)
            if (ctx && ctx.ui && typeof ctx.ui.notify === 'function') ctx.ui.notify(out.text || 'ok', out.isError ? 'error' : 'info')
          },
        })
        report.commands.push(name)
      } catch (e) {
        report.skipped.push('command ' + name + ': ' + shortMessage(e))
      }
      continue
    }
    if (cap.kind === 'skill') {
      if (cap.dir) skillDirs.push(cap.dir)
      else report.skipped.push('skill ' + cap.name + ' carries no directory to contribute')
      continue
    }
    if (cap.kind === 'provider') { report.skipped.push('model provider is host-specific: ' + cap.name); continue }
    report.skipped.push('unsupported capability kind: ' + cap.kind)
  }

  for (const dir of captured.skillDirs || []) skillDirs.push(dir)

  if (skillDirs.length) {
    try {
      const unique = [...new Set(skillDirs)]
      pi.on('resources_discover', async () => ({ skillPaths: unique }))
      report.skills = unique
    } catch (e) {
      report.skipped.push('skill contribution failed: ' + shortMessage(e))
    }
  }

  for (const item of captured.events || []) {
    const targets = mapEvent('pi', item.event)
    if (!targets.length) { report.skipped.push('event has no pi equivalent: ' + item.event); continue }
    for (const target of targets) {
      try { pi.on(target, (...args) => item.handler(...args)) } catch (e) { report.skipped.push('event ' + target + ': ' + shortMessage(e)) }
    }
    // The name maps; the payload does not. This path only runs when no host could
    // be supplied, so the handler observes that something happened, with pi's
    // payload where it expected its own host's. Saying so is the difference
    // between a degraded mode and a silent lie.
    report.events.push(item.event + ' -> ' + targets.join('|') + ' (pi payloads, observation only)')
  }
  return report
}

function shortMessage (e) {
  return e && e.message ? String(e.message).slice(0, 200) : String(e)
}
