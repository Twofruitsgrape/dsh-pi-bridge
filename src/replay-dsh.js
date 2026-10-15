/**
 * Replay captured pi capabilities into a real DSH scope.
 *
 * The shapes come from the hosts' own packages: dsh-tools' defineTool takes a
 * property spec map, compiles it to JSON Schema, and requires an output schema
 * with a render function; dsh-commands takes { name, description, input,
 * handler } where the handler answers { kind: 'success' | 'error', text }.
 * Skills go through the skill registry provider interface, the same one
 * dsh-comsol uses.
 *
 * defineTool is imported lazily: the module must still load under a mock host
 * (the offline self-test), where the fallback compiles the spec map itself.
 *
 * Anything the local host has no equivalent for is returned in a report rather
 * than dropped silently, so pi_install can say what actually arrived.
 *
 * @module src/replay-dsh.js
 */
import { mapEvent } from './capabilities.js'
import { specToJsonSchema } from './schema.js'

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    result: { type: 'string', required: true },
  },
}

/** Host defineTool when present; a faithful stand-in otherwise. */
async function toolCompiler () {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
  } catch { /* mock host */ }
  return (options) => ({
    ...options,
    parameters: specToJsonSchema(options.parameters),
    execute: async (args, exec) => options.execute(args, exec),
  })
}

/**
 * @param {any} ctx DSH scope for this plugin
 * @param {any} captured result of capturePi
 * @param {{prefix?: string}} [options]
 * @returns {Promise<{tools:string[],commands:string[],skills:string[],events:string[],skipped:string[]}>}
 */
export async function replayIntoDsh (ctx, captured, options) {
  const defineTool = await toolCompiler()
  const prefix = (options && options.prefix) || ''
  const report = { tools: [], commands: [], skills: [], events: [], skipped: [] }
  if (prefix && !/^[a-z][a-z0-9_]*$/.test(prefix)) report.skipped.push('prefix must be lowercase ascii: ' + prefix)

  for (const cap of captured.capabilities || []) {
    const name = prefix ? prefix + '_' + cap.name : cap.name
    if (cap.kind === 'tool') {
      if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') { report.skipped.push('tools service missing; ' + name); continue }
      try {
        ctx.tools.register(defineTool({
          name,
          description: (cap.description || '(no description)') + ' [bridged by dsh-pi-bridge from ' + (cap.origin || 'pi') + ']',
          parameters: cap.spec,
          output: {
            schema: OUT_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: (value && value.result) || '' }],
          },
          execute: async (args, exec) => {
            const out = await cap.run(args, exec)
            return { ok: true, result: out.text || JSON.stringify(out.structured === undefined ? null : out.structured) }
          },
        }))
        report.tools.push(name)
      } catch (e) {
        report.skipped.push('tool ' + name + ': ' + shortMessage(e))
      }
      continue
    }
    if (cap.kind === 'command') {
      const register = ctx.commands && ctx.commands.register
      if (typeof register !== 'function') { report.skipped.push('commands service missing; /' + name); continue }
      try {
        register.call(ctx.commands, {
          name,
          description: (cap.description || '') + ' [dsh-pi-bridge]',
          ...(cap.hint ? { input: { hint: cap.hint } } : {}),
          handler: async (invocation) => {
            const rawInput = invocation && invocation.rawInput
            const out = await cap.run(String(rawInput || ''), invocation || {})
            return out.isError ? { kind: 'error', text: out.text } : { kind: 'success', text: out.text || 'ok' }
          },
        })
        report.commands.push(name)
      } catch (e) {
        report.skipped.push('command ' + name + ': ' + shortMessage(e))
      }
      continue
    }
    if (cap.kind === 'skill') continue
    if (cap.kind === 'provider') { report.skipped.push('model provider is host-specific: ' + cap.name); continue }
  }

  for (const dir of captured.skillDirs || []) {
    if (!ctx || !ctx.skills || typeof ctx.skills.registerProvider !== 'function') { report.skipped.push('skills service missing; ' + dir); continue }
    try {
      ctx.skills.registerProvider(() => skillProviderFor(dir))
      report.skills.push(dir)
    } catch (e) {
      report.skipped.push('skill dir: ' + shortMessage(e))
    }
  }

  for (const item of captured.events || []) {
    const targets = mapEvent('dsh', item.event)
    if (!targets.length) { report.skipped.push('event has no DSH equivalent: ' + item.event); continue }
    for (const target of targets) {
      try {
        ctx.on(target, (...args) => item.handler(...args))
      } catch (e) {
        report.skipped.push('event ' + target + ': ' + shortMessage(e))
      }
    }
    report.events.push(item.event + ' -> ' + targets.join('|'))
  }
  return report
}

/**
 * Skill provider for one SKILL.md directory, read on demand so an on-disk
 * update is picked up without reloading the plugin.
 * @param {string} dir
 */
export async function skillProviderFor (dir) {
  const { readFile } = await import('node:fs/promises')
  const nodePath = await import('node:path')
  const { parseFrontmatter } = await import('./manifest.js')
  const file = nodePath.join(dir, 'SKILL.md')
  let text = ''
  try { text = await readFile(file, 'utf8') } catch { return { list: () => [], get: () => null } }
  const fm = parseFrontmatter(text)
  const meta = {
    name: fm.name || nodePath.basename(dir),
    description: fm.description || '',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-pi-bridge',
    source: 'bundled',
    resourceBase: { kind: 'directory', path: dir },
    locator: file,
  }
  return {
    list: () => [meta],
    get: (candidate) => ({ ...meta, name: (candidate && candidate.name) || meta.name, content: text }),
  }
}

function shortMessage (e) {
  return e && e.message ? String(e.message).slice(0, 200) : String(e)
}
