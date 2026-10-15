/**
 * Capability capture: load a foreign plugin against a stand-in host and record
 * what it registers.
 *
 * The two hosts have different entry conventions:
 *   pi   - default export factory receiving an ExtensionAPI
 *   DSH  - name / inject / Config exports plus apply(ctx, config)
 *
 * So each direction needs the other host's API surface, reduced to the methods
 * that register capabilities and recording instead of executing. Everything
 * the foreign plugin registers becomes a Capability record that the local
 * replay side can then install for real.
 *
 * @module src/capture.js
 */
import { toToolSchema, toToolSpec } from './schema.js'
import { projectResult } from './capabilities.js'

/**
 * Normalize one foreign tool.
 * @param {any} raw
 * @param {string} origin
 * @param {'pi'|'dsh'} sourceHost the calling convention to adapt from
 */
function makeTool (raw, origin, sourceHost) {
  const schema = toToolSchema(raw.parameters)
  const spec = toToolSpec(raw.parameters)
  const name = String(raw.name || 'unnamed_tool')
  return {
    kind: 'tool',
    name,
    label: String(raw.label || raw.title || name),
    description: String(raw.description || ''),
    schema,
    spec,
    origin,
    run: async (args, ctx) => {
      if (typeof raw.execute !== 'function') return projectResult({ content: [{ type: 'text', text: 'bridged tool has no execute()' }] })
      // pi: execute(toolCallId, params, signal, onUpdate, ctx). DSH: execute(args, exec).
      const result = sourceHost === 'pi'
        ? await raw.execute('dsh-pi-bridge', args, ctx && ctx.signal, undefined, ctx)
        : await raw.execute(args, ctx)
      return projectResult(result)
    },
    notes: [],
  }
}

function makeCommand (raw, origin) {
  return {
    kind: 'command',
    name: String(raw.name || 'unnamed').replace(/^\/+/, ''),
    description: String(raw.description || ''),
    hint: raw.input && raw.input.hint ? String(raw.input.hint) : (raw.usage ? String(raw.usage) : undefined),
    origin,
    run: async (input, ctx) => {
      const handler = raw.handler || raw.run
      if (!handler) return { text: 'bridge command has no handler', isError: false }
      const out = await handler(input, ctx)
      return projectResult(out === undefined ? { text: 'ok' } : out)
    },
  }
}

/**
 * A stand-in pi ExtensionAPI that records registrations.
 * @param {string} origin package name recorded on every capability
 */
export function createPiRecorder (origin) {
  const SOURCE = 'pi'
  const capabilities = []
  const events = []
  const unsupported = []
  const recorder = {
    registerTool (tool) {
      capabilities.push(makeTool(tool || {}, origin, SOURCE))
    },
    registerCommand (name, options) {
      capabilities.push(makeCommand({ ...(options || {}), name }, origin))
    },
    registerProvider (id, definition) {
      capabilities.push({ kind: 'provider', name: String(id || 'provider'), description: String((definition && definition.baseUrl) || ''), origin, run: async () => projectResult({ text: 'providers are not replayed across hosts' }), notes: ['provider registration is host-specific'] })
    },
    registerSkill (skill) {
      capabilities.push({ kind: 'skill', name: String((skill && skill.name) || 'skill'), description: String((skill && skill.description) || ''), dir: String((skill && skill.dir) || ''), origin, run: async () => projectResult({ text: '' }), notes: [] })
    },
    on (event, handler) {
      events.push({ event: String(event), handler })
      return () => {
        const i = events.findIndex(e => e.handler === handler)
        if (i >= 0) events.splice(i, 1)
      }
    },
    events: { on: (name, handler) => recorder.on(String(name), handler) },
    sendMessage: noop(unsupported, 'sendMessage'),
    sendUserMessage: noop(unsupported, 'sendUserMessage'),
    appendEntry: noop(unsupported, 'appendEntry'),
    registerShortcut: noop(unsupported, 'registerShortcut'),
    registerFlag: noop(unsupported, 'registerFlag'),
    getFlag: () => undefined,
    setActiveTools: noop(unsupported, 'setActiveTools'),
    setModel: noop(unsupported, 'setModel'),
    setThinkingLevel: noop(unsupported, 'setThinkingLevel'),
    getState: () => undefined,
    setState: noop(unsupported, 'setState'),
  }
  // A real package uses API surface this recorder has never seen
  // (registerMessageRenderer, and whatever ships next). Unknown methods are
  // recorded as unsupported and return undefined so capture continues and the
  // rest of the package still arrives.
  const api = new Proxy(recorder, {
    get (target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop]
      if (!/^register|send|append|set/.test(prop)) return target[prop]
      return (...args) => { void args; unsupported.push(prop) }
    },
  })
  return { api, capabilities, events, unsupported }
}

function noop (list, name) {
  return (...args) => {
    void args
    list.push(name)
    return undefined
  }
}

/**
 * A stand-in DSH ctx (cordis scope) that records registrations.
 * @param {string} origin
 */
export function createDshRecorder (origin) {
  const SOURCE = 'dsh'
  const capabilities = []
  const events = []
  const unsupported = []
  const skillProviders = []
  const ctx = {
    tools: {
      register (tool) { capabilities.push(makeTool(tool || {}, origin, SOURCE)) },
      get: () => undefined,
      list: () => [],
    },
    commands: {
      register (definition) { capabilities.push(makeCommand(definition || {}, origin)) },
    },
    command: {
      register (definition) { capabilities.push(makeCommand(definition || {}, origin)) },
    },
    skills: {
      registerProvider (fn) {
        // Defer: provider.list() is asynchronous in real bundles such as
        // dsh-comsol, and the factory itself may be async.
        skillProviders.push(fn)
      },
      register (skill) { capabilities.push({ kind: 'skill', name: String((skill && skill.name) || 'skill'), description: String((skill && skill.description) || ''), dir: '', origin, run: async () => projectResult({ text: '' }), notes: [] }) },
    },
    llm: {
      registerAdapter: noop(unsupported, 'llm.registerAdapter'),
      registerConfigurableProviders: noop(unsupported, 'llm.registerConfigurableProviders'),
      registerModelDiscovery: noop(unsupported, 'llm.registerModelDiscovery'),
    },
    systemPrompt: { section: noop(unsupported, 'systemPrompt.section'), getSectionOrder: () => [], context: async () => ({}) },
    sessions: { get: () => undefined, list: { getSnapshot: () => [] }, flush: async () => true },
    slots: { register: noop(unsupported, 'slots.register'), inject: noop(unsupported, 'slots.inject') },
    locale: { register: noop(unsupported, 'locale.register') },
    approval: { request: async () => ({ approved: false, reason: 'bridge capture context' }) },
    webServer: { register: noop(unsupported, 'webServer.register') },
    subagents: {},
    events: { dispatch: () => [] },
    // cordis scope extras real bundles reach for; recording only, never running.
    effect (fn) { try { return fn(() => {}) } catch { return undefined } },
    schedule: () => ({ cancel () {}, start () {}, status: 'idle' }),
    fork: () => ctx,
    scope: () => ctx,
    logger: { info () {}, warn () {}, debug () {}, error () {} },
    // cordis ctx.inject(names, cb) runs cb with the scope when every named
    // service exists; the recorder honours that so registrations made inside
    // an inject callback are not missed.
    inject (names, cb) {
      if (typeof cb !== 'function') return undefined
      const wanted = Array.isArray(names) ? names : [names]
      for (const n of wanted) if (!(n in bagRef)) return undefined
      return cb(bagRef)
    },
    on (name, handler) {
      events.push({ event: String(name), handler })
      return () => {}
    },
  }
  // cordis ctx carries far more than the recorder models: provide, fork,
  // service handles, per-plugin state. Unknown properties answer with a
  // recording stub so one unfamiliar service cannot abort the whole capture.
  const bagRef = new Proxy(ctx, {
    get (target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop]
      if (prop === 'provide') return (spec) => spec
      const name = prop
      // Callable as well as chainable: real bundles write ctx.get(id),
      // ctx.state.foo(), so the synthesized service must be a function target.
      return recording(name, unsupported)
    },
  })
  return { ctx: bagRef, capabilities, events, unsupported, skillProviders }
}

/**
 * Resolve every deferred DSH skill provider into skill records. Providers may
 * be async factories and their list() may be async, so both are awaited.
 * @param {any[]} providers
 * @param {string} origin
 * @param {string[]} errors
 */
async function resolveSkillProviders (providers, origin, errors) {
  const skills = []
  const dirs = []
  for (const fn of providers) {
    try {
      const provider = typeof fn === 'function' ? await fn() : fn
      if (!provider || typeof provider.list !== 'function') continue
      const listed = await provider.list()
      for (const item of listed || []) {
        const base = item && item.resourceBase
        const dir = base && base.kind === 'directory' ? base.path : ''
        skills.push({
          kind: 'skill',
          name: String((item && item.name) || 'skill'),
          description: String((item && item.description) || ''),
          dir,
          origin,
          run: async () => projectResult({ text: '' }),
          notes: [],
        })
        if (dir) dirs.push(dir)
      }
    } catch (e) {
      errors.push('skill provider: ' + (e && e.message ? e.message : String(e)))
    }
  }
  return { skills, dirs }
}

/**
 * A recording stand-in for a host service the recorder does not model. It is
 * callable, chainable, and records every property or call it receives so the
 * report can say what the package asked for.
 * @param {string} label
 * @param {string[]} sink
 */
function recording (label, sink) {
  // Callers chain on the result: ctx.get(id)?.name, ctx.sessions.list.getSnapshot().
  // Returning undefined there is a crash the host would never produce, so a
  // recorded call answers with another recording.
  const fn = function () { return recording(label + '()', sink) }
  return new Proxy(fn, {
    get (_t, key) {
      // Spreadable: bundles write [...ctx.registry.values] and expect an empty
      // enumeration rather than a TypeError when the service is faked.
      if (key === Symbol.iterator) return function * () {}
      if (typeof key !== 'string' || key === 'then') return undefined
      if (key === 'name' || key === 'length' || key === 'prototype') return undefined
      if (key === 'toString') return () => '[dsh-pi-bridge recorder ' + label + ']'
      return (...args) => { void args; sink.push(label + '.' + key); return recording(label + '.' + key + '()', sink) }
    },
    apply (_t, _this, args) { void args; sink.push(label + '()'); return recording(label + '()()', sink) },
  })
}

/**
 * Load a pi package's extension files against the recorder.
 * @param {string[]} files absolute ESM paths
 * @param {string} origin
 */
export async function capturePi (files, origin) {
  const bag = createPiRecorder(origin)
  const errors = []
  for (const file of files) {
    try {
      const mod = await import(pathUrl(file))
      const factory = mod.default || mod.activate || mod.extension
      if (typeof factory === 'function') await factory(bag.api)
      else if (mod.setup && typeof mod.setup === 'function') await mod.setup(bag.api)
      else errors.push('no default extension factory in ' + file)
    } catch (e) {
      errors.push(file + ': ' + (e && e.message ? e.message : String(e)))
    }
  }
  return { ...bag, errors }
}

/**
 * Load a DSH bundle entry against the recorder.
 * @param {string} entry absolute path to the bundle's main module
 * @param {string} origin
 * @param {any} config
 */
export async function captureDsh (entry, origin, config) {
  const bag = createDshRecorder(origin)
  const errors = []
  try {
    const mod = await import(pathUrl(entry))
    const target = mod.default && typeof mod.default.apply === 'function' ? mod.default : mod
    const apply = target.apply
    if (typeof apply !== 'function') errors.push('no apply() export in ' + entry)
    else {
      const needs = Array.isArray(target.inject) ? target.inject : []
      // Bundles commonly write 'export async function apply' (dsh-computer-use
      // does): registering happens after a microtask, so it must be awaited.
      await apply(bag.ctx, config || {})
      for (const svc of needs) {
        if (!(svc in bag.ctx)) bag.unsupported.push('inject:' + svc)
      }
    }
    if (mod.name) bag.pluginName = String(mod.name)
  } catch (e) {
    errors.push(entry + ': ' + (e && e.message ? e.message : String(e)))
  }
  const resolved = await resolveSkillProviders(bag.skillProviders, origin, errors)
  bag.capabilities.push(...resolved.skills)
  return { ...bag, errors, skillDirs: resolved.dirs }
}

function pathUrl (p) {
  const s = p.replace(/\\/g, '/')
  return (/^[A-Za-z]:\//.test(s) ? 'file:///' + s : 'file://' + s)
}
