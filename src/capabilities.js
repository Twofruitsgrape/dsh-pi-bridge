/**
 * The normalized capability model both adapters speak.
 *
 * A foreign plugin is loaded against a recording stand-in host (capture.js);
 * whatever it registers becomes one of these records. Replaying the records
 * into the local host (replay-dsh.js / replay-pi.js) is what makes a pi
 * package usable inside DSH and a DSH bundle usable inside pi.
 *
 * Capability kinds: tool (model-callable), command (user slash command),
 * skill (SKILL.md directory), provider (host-specific, reported only).
 *
 * @module src/capabilities.js
 */

/** Event names each side can receive, keyed by the LOCAL host being replayed into. */
export const EVENT_MAP = {
  dsh: {
    session_start: ['agent/created'],
    session_shutdown: ['agent/disposed'],
    agent_start: ['agent/status'],
    agent_end: ['agent/status'],
    turn_start: ['agent/status'],
    turn_end: ['agent/status'],
    tool_call: ['tools/pre-execute'],
    tool_execution_start: ['tools/pre-execute'],
    tool_result: ['tools/post-execute'],
    tool_execution_end: ['tools/post-execute'],
  },
  pi: {
    'agent/created': ['session_start'],
    'agent/disposed': ['session_shutdown'],
    'agent/status': ['agent_start'],
    'tools/pre-execute': ['tool_call'],
    'tools/post-execute': ['tool_result'],
    'system-prompt/assemble': ['context'],
  },
}

/** @param {'pi'|'dsh'} localHost @param {string} event as the foreign host named it */
export function mapEvent (localHost, event) {
  const table = EVENT_MAP[localHost] || {}
  const hit = table[event]
  return Array.isArray(hit) ? hit : []
}

function safeStringify (v) {
  try { return typeof v === 'string' ? v : JSON.stringify(v) } catch { return String(v) }
}

/**
 * Project a foreign tool result onto the lowest common denominator: text,
 * a structured value, and any image blocks. Understands pi's
 * { content: [{ type: 'text' | 'image' }] } and DSH's { ok, result } /
 * { text } shapes, and falls back to JSON for anything else.
 * @param {any} value
 * @returns {{text:string, structured:any, images:any[], isError:boolean}}
 */
export function projectResult (value) {
  const images = []
  if (value == null) return { text: '', structured: null, images, isError: false }
  if (typeof value === 'string') return { text: value, structured: null, images, isError: false }
  if (typeof value !== 'object') return { text: String(value), structured: value, images, isError: false }

  if (Array.isArray(value.content)) {
    let text = ''
    for (const block of value.content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' || typeof block.text === 'string') text += (text ? '\n' : '') + String(block.text ?? '')
      else if (block.type === 'image' || block.type === 'image_content' || block.type === 'img') images.push(block)
    }
    const structured = value.structuredContent !== undefined ? value.structuredContent : (value.details !== undefined ? value.details : null)
    return { text: text || safeStringify(structured), structured, images, isError: value.isError === true }
  }
  if (typeof value.result === 'string') return { text: value.result, structured: value, images, isError: value.ok === false }
  if (typeof value.text === 'string') return { text: value.text, structured: value, images, isError: value.isError === true || value.kind === 'error' }
  return { text: safeStringify(value), structured: value, images, isError: false }
}
