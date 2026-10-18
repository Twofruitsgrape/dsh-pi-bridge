/**
 * Introspection fixture: answers, with evidence rather than another guess, why
 * seven published bundles are refused with "cannot create effect on inactive
 * context".
 *
 * This bridge has mis-blamed that message three times now (first for a missing
 * profile service, then for a stale session). The message names neither a service
 * nor a call site, so ask the live host directly: try each way a bundle could
 * acquire a lifecycle scope, inside apply(), and report which ones the host
 * accepts. Whatever works here is what the loader should use instead of applying
 * a bundle against the injected child scope.
 */
export const name = 'dsh-introspect-fixture'
export const inject = ['tools']

export function apply (ctx) {
  const report = {}
  report.scopeKeys = Object.keys(ctx).filter((k) => typeof k === 'string').slice(0, 40)
  try { report.proto = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx) || []).slice(0, 30) }
  catch { report.proto = [] }

  // What the scope exposes for lifecycle work, probed one name at a time: a
  // service the fiber did not declare throws when read, so one bad name must not
  // cost the whole snapshot.
  report.types = {}
  const NAMES = ['effect', 'fork', 'plugin', 'plugins', 'provide', 'inject', 'on', 'teardown', 'mount', 'hot']
  for (const n of NAMES) {
    try { report.types[n] = typeof ctx[n] }
    catch (e) { report.types[n] = 'GET-THREW: ' + String((e && e.message) || e).slice(0, 70) }
  }

  // 1. What the refused bundles do: register an effect on the given scope.
  report.effectOnScope = 'no effect property'
  if (typeof ctx.effect === 'function') {
    try { ctx.effect(() => () => {}); report.effectOnScope = 'created cleanly' }
    catch (e) { report.effectOnScope = 'THREW: ' + String((e && e.message) || e).slice(0, 120) }
  }

  // 2. Fork a child fiber and try an effect there.
  report.fork = 'no fork property'
  if (typeof ctx.fork === 'function') {
    try {
      const child = ctx.fork('probe')
      report.fork = 'forked ok, child.effect=' + typeof (child && child.effect)
      if (child && typeof child.effect === 'function') {
        try { child.effect(() => () => {}); report.fork += '; effect created cleanly' }
        catch (e) { report.fork += '; effect THREW: ' + String((e && e.message) || e).slice(0, 90) }
      }
    } catch (e) { report.fork = 'THREW: ' + String((e && e.message) || e).slice(0, 120) }
  }

  // 3. Mount the way cordis does: ctx.plugin(impl) runs impl in a tracked child
  //    fiber, which is exactly the context an effect needs.
  report.plugin = 'no plugin property'
  if (typeof ctx.plugin === 'function') {
    const dummy = {
      name: 'probe-dummy',
      inject: ['tools'],
      apply (inner) {
        try {
          inner.tools.register({
            name: 'probe_dummy_tool',
            description: 'proof it mounted',
            parameters: { q: { type: 'string', description: 'x' } },
            output: {
              schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
              render: (a, v) => [{ type: 'text', text: v.result }],
            },
            execute: async () => ({ ok: true, result: 'DUMMY' }),
          })
        } catch (e) { report.pluginRegister = 'register THREW: ' + String((e && e.message) || e).slice(0, 90) }
        if (typeof inner.effect === 'function') {
          try { inner.effect(() => () => {}); report.pluginEffect = 'created cleanly' }
          catch (e) { report.pluginEffect = 'THREW: ' + String((e && e.message) || e).slice(0, 90) }
        } else {
          report.pluginEffect = 'no effect on child scope: ' + typeof inner.effect
        }
      },
    }
    try {
      const mounted = ctx.plugin(dummy)
      report.plugin = 'plugin() returned ' + typeof mounted
      try {
        const listed = (ctx.tools && ctx.tools.items ? [...ctx.tools.items] : []).map((t) => t && t.name)
        report.pluginToolSeen = listed.indexOf('probe_dummy_tool') >= 0
      } catch (e) { report.pluginToolSeen = 'check THREW: ' + String((e && e.message) || e).slice(0, 70) }
    } catch (e) { report.plugin = 'THREW: ' + String((e && e.message) || e).slice(0, 120) }
  }

  const snapshot = JSON.stringify(report)

  ctx.tools.register({
    name: 'is_probe',
    description: 'Return the live scope battery results taken at load time.',
    parameters: { q: { type: 'string', description: 'ignored' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
      render: (a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async () => ({ ok: true, result: snapshot }),
  })

  ctx.tools.register({
    name: 'is_hold',
    description: 'Wait for a bounded time so a live session can be probed.',
    parameters: { ms: { type: 'number', required: true, description: 'milliseconds, capped at 290000' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, result: { type: 'string' } } },
      render: (a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (a) => {
      const ms = Math.min(Number(a.ms) || 0, 290000)
      await new Promise((r) => setTimeout(r, ms))
      return { ok: true, result: 'HELD:' + ms }
    },
  })
}
