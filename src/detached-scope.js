/**
 * A scope for mounting a bundle when no live fiber is available.
 *
 * WHY THIS EXISTS, measured on a real session with DSH_PI_BRIDGE_DEBUG=1:
 *
 *   apply:          uid=78 state=1   (this plugin own fiber, active)
 *   serve request:  uid=null state=4 (DISPOSED, the same fiber)
 *
 * Cordis resolves services and registers effects against the fiber a call is made
 * on, and plugin() begins with ctx.fiber.assertActive(). So every mount attempted
 * from the serve endpoint callback threw "cannot create effect on inactive
 * context" - for every bundle, this bridge own fixture included. That is why the
 * same bundle loads fine through the dsh_install tool (the host invokes tools on
 * an active fiber) and fails over HTTP; and it is the asymmetry that made "the
 * profile is missing a service" look believable across three wrong guesses.
 *
 * Mounting on ctx.root instead passes assertActive but goes nowhere: on the live
 * host root.tools is undefined and root.inject(["tools"], cb) settles without ever
 * calling cb, because the session root composes only the base services. So the
 * snapshot taken while apply() was running - real service objects, owned by the
 * HOST still-live fibers - is the one thing that works: a tool registry does not
 * care which fiber asked it to register.
 *
 * What this is honest about: effects registered here are collected and disposed
 * with the bridge rather than tracked by cordis, so a bundle cleanup runs on
 * removal instead of on a host reload. What it cannot offer is a service that was
 * not readable during apply(); those stay a real refusal, reported by name.
 *
 * @module src/detached-scope.js
 */

/**
 * @param {Record<string, any>} snapshot services read off the live scope during apply()
 * @param {{log?:(m:string)=>void}} [opts]
 * @returns {any} a scope usable as the second argument of loadDshBundle()
 */
export function createDetachedScope (snapshot, opts) {
  const log = (opts && opts.log) || (() => {})
  /**
   * Keep the caller's object by reference, not a copy.
   *
   * A copy here was measured as the whole missing-service symptom of the
   * "GUI 重新测一批" round: the caller collects its service snapshot partly
   * through async inject probes whose callbacks settle in later microtasks,
   * while this scope was created synchronously inside apply(). Copying at that
   * instant preserves an almost-empty service store, and every probe result
   * that lands afterwards is silently invisible to this scope - which then
   * reports 'does not compose webServer' for a session that had been serving a
   * browser UI on that service for minutes. Sharing the same object keeps
   * late-arriving service entries visible at every later load, which is what
   * the caller's probe design assumes.
   */
  const services = snapshot || Object.create(null)
  /** Cleanups the bundles registered through effect(), in registration order. */
  const cleanups = []
  /** Every scope handed out, so dispose() can tear down deferred children too. */
  const children = []

  const effectShim = (factory) => {
    try {
      const dispose = typeof factory === "function"
        ? factory((fn) => { if (typeof fn === "function") cleanups.push(fn) })
        : undefined
      if (typeof dispose === "function") cleanups.push(dispose)
    } catch (e) {
      // A bundle effect body can fail for its own reasons (a service it did not
      // declare, say). Recording that beats letting it abort a load that had
      // already registered its tools.
      log('detached effect failed: ' + String((e && e.message) || e).slice(0, 120))
    }
    return { dispose () {} }
  }

  /**
   * cordis-plugin-timer mixes timeout/interval/setTimeout/setInterval/
   * throttle/debounce into every real context. A bundle that calls ctx.interval()
   * therefore works on a live host and died here with "ctx.interval is not a
   * function" (measured: dsh-bottom-info-bar). The callback form returns a
   * disposer and the no-callback form returns a promise or an async iterator, as
   * the timer service does; every pending timer is cleared when the scope disposes.
   */
  const timers = new Set()
  const trackTimer = (stop) => {
    let stopped = false
    const dispose = () => {
      if (stopped) return
      stopped = true
      timers.delete(dispose)
      try { stop() } catch { /* already cleared */ }
    }
    timers.add(dispose)
    return dispose
  }
  const timerHelpers = {
    timeout (...args) {
      const callback = typeof args[0] === 'function' ? args.shift() : undefined
      const delay = Number(args[0]) || 0
      let handle = null
      if (callback) {
        const dispose = trackTimer(() => { if (handle !== null) clearTimeout(handle) })
        handle = setTimeout(() => { dispose(); try { callback() } catch (e) { log('detached timeout failed: ' + String((e && e.message) || e).slice(0, 120)) } }, delay)
        return dispose
      }
      const { promise, resolve, reject } = Promise.withResolvers()
      const dispose = trackTimer(() => { if (handle !== null) clearTimeout(handle); reject(new Error('Context has been disposed')) })
      handle = setTimeout(() => { dispose(); resolve(undefined) }, delay)
      return promise
    },
    interval (...args) {
      const callback = typeof args[0] === 'function' ? args.shift() : undefined
      const delay = Number(args[0]) || 0
      let handle = null
      if (callback) {
        const dispose = trackTimer(() => { if (handle !== null) clearInterval(handle) })
        handle = setInterval(() => { try { callback() } catch (e) { log('detached interval failed: ' + String((e && e.message) || e).slice(0, 120)) } }, delay)
        return dispose
      }
      const queue = []
      let waiter = null
      let stopped = false
      const dispose = trackTimer(() => {
        stopped = true
        if (handle !== null) clearInterval(handle)
        if (waiter) { const w = waiter; waiter = null; w.reject(new Error('Context has been disposed')) }
      })
      handle = setInterval(() => {
        if (stopped) return
        const item = { done: false, value: undefined }
        if (waiter) { const w = waiter; waiter = null; w.resolve(item) } else queue.push(item)
      }, delay)
      return {
        [Symbol.asyncIterator] () { return this },
        next () {
          if (queue.length) return Promise.resolve(queue.shift())
          if (stopped) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve, reject) => { waiter = { resolve, reject } })
        },
        return () { dispose(); return Promise.resolve({ done: true, value: undefined }) },
      }
    },
    setTimeout (callback, delay) { return timerHelpers.timeout(callback, delay) },
    setInterval (callback, delay) { return timerHelpers.interval(callback, delay) },
    throttle (callback, delay) {
      let last = 0
      let handle = null
      let pending = null
      const dispose = trackTimer(() => { if (handle !== null) clearTimeout(handle) })
      const wrapped = (...args) => {
        const now = Date.now()
        if (now - last >= delay) { last = now; return callback(...args) }
        pending = args
        if (handle === null) {
          handle = setTimeout(() => { handle = null; last = Date.now(); const a = pending; pending = null; if (a) callback(...a) }, Math.max(0, delay - (now - last)))
        }
        return undefined
      }
      wrapped.dispose = dispose
      return wrapped
    },
    debounce (callback, delay) {
      let handle = null
      const wrapped = (...args) => {
        if (handle !== null) clearTimeout(handle)
        handle = setTimeout(() => { handle = null; callback(...args) }, delay)
      }
      wrapped.dispose = trackTimer(() => { if (handle !== null) clearTimeout(handle) })
      return wrapped
    },
  }
  const TIMER_KEYS = ['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce']

  const ev = services.events
  const base = {
    effect: effectShim,
    // Events go to the host real event service when the snapshot has one: a
    // bundle subscribing to a lifecycle event must not silently no-op.
    on: ev && typeof ev.on === "function" ? (name, handler) => ev.on(name, handler) : () => () => {},
    once: ev && typeof ev.once === "function" ? (name, handler) => ev.once(name, handler) : () => () => {},
    emit: ev && typeof ev.emit === "function" ? (name, ...args) => { ev.emit(name, ...args) } : () => {},
    /**
     * Cordis inject runs the callback synchronously with a child scope carrying
     * exactly the names asked for, and returns a handle. Same shape, same timing,
     * no fiber: this is what lets a bundle that registers inside ctx.inject have
     * its tools land, which the loader reports as deferred registrations.
     */
    inject (names, callback) {
      const list = Array.isArray(names) ? names : [names]
      // Cordis only runs the callback when every named service composes; a name
      // it cannot supply leaves the callback unexecuted. Mirror that exactly:
      // handing a bundle a child scope with undefined services would let it run
      // and fail somewhere deep with a TypeError that reads like a bundle bug.
      // The loader detects the refusal through its own ran-flag and reports the
      // named service as not composed, which is the truth of the snapshot.
      if (list.some((n) => services[n] === undefined)) return undefined
      // A cordis inject child still sees the parent's services; it only ADDS the
      // named ones as required. Handing it just the listed names broke a real
      // pattern - registering a tool from inside inject(['commands'], inner =>
      // inner.tools.register(...)) died on "reading 'register'". The plugin()
      // child below carries the same shape for the same reason.
      const child = {}
      for (const [n, v] of Object.entries(services)) child[n] = v
      for (const n of list) child[n] = services[n]
      child.effect = effectShim
      child.inject = base.inject.bind(base)
      child.on = base.on
      child.once = base.once
      child.emit = base.emit
      // The child scope needs the full shim surface, not just the event
      // methods: a bundle composes helper plugins from INSIDE an inject
      // callback (measured live: dsh-univer-office's apply injected
      // [tools, web], and its inner callback died with "ctx.plugin is not a
      // function" because the inject child carried no plugin). provide and
      // missing belong here for the same reason - an inner callback can
      // register a service and ask what is absent just like a top-level one.
      child.provide = base.provide
      child.get = base.get
      child.plugin = base.plugin
      child.missing = base.missing
      child.reflect = base.reflect
      for (const k of TIMER_KEYS) child[k] = base[k]
      children.push(child)
      // Propagate a throwing callback: a bundle that fails while registering is
      // the bundle problem and the loader reports it with the bundle name.
      // Swallowing it here is how a broken load would read as a successful empty
      // one - the exact class of bug this bridge has been chasing all day.
      // Returning the bundle promise instead of dropping it is what keeps a
      // plugin from killing the host. A callback here is often an async apply();
      // calling it and ignoring its result leaves any rejection unawaited, and an
      // unhandled rejection terminates the process. Measured on a live session:
      // @furongjun1999/dsh-memory rejected inside apply, the host printed "dsh:
      // fatal load failure" with a stack ending on this very line, the DSH process
      // died, and the six loads still queued in that batch each got ECONNREFUSED.
      // The loader awaits whatever inject hands back, so a rejection becomes a
      // reported load failure for that one bundle.
      const out = callback(child)
      if (out && typeof out.then === 'function') {
        // A bundle's own ctx.inject([...], async () => ...) is never awaited by the
        // loader, and rethrowing into that unowned promise is an unhandled
        // rejection - which terminates the host process. Measured: npm:@michengai/
        // dsh-automation rejected inside a deferred callback and the whole serve
        // session died mid-batch. The chained catch keeps the rejection visible to
        // a caller that awaits while leaving no promise without a handler.
        const chained = out.then(
          () => ({ dispose () {} }),
          (e) => { throw e },
        )
        chained.catch((e) => { log('detached inject callback rejected: ' + String((e && e.message) || e).slice(0, 160)) })
        return chained
      }
      return { dispose () {} }
    },
    /**
     * Which of these names the snapshot cannot supply.
     *
     * Cordis leaves an inject callback unexecuted when any named service is
     * absent, and this scope mirrors that - but the loader then reported EVERY
     * declared service as missing, which is wrong in a way that sends the user
     * to fix the wrong thing. @dfy-plugins/dsh-visualize asks for tools, fs,
     * skills and sessionPersistence; the session composes tools and skills, so
     * only fs and sessionPersistence were actually absent. Naming the exact
     * ones turns a vague refusal into an actionable one.
     */
    missing (names) {
      const list = Array.isArray(names) ? names : [names]
      return list.filter((n) => services[n] === undefined)
    },
    provide (name, value) { services[name] = value; return value },
    /**
     * Cordis's own ctx.get(name): read a service without an inject requirement.
     *
     * A bundle's execute() block reaches for optional services this way rather
     * than through inject - npm:dingpenghui/agnes-image resolves 'credentials'
     * and 'attachments' with ctx.get, and without it every generate_image call
     * died with 'ctx.get is not a function'. The snapshot holds the real service
     * objects owned by live host fibers, so returning them is the same answer the
     * host context gives; a name never captured stays undefined and the bundle
     * reports that in its own words.
     */
    get (name) { return services[name] },
    /**
     * The reflect view real cordis contexts expose. A bundle that subclasses
     * the HOST's own Service class constructs its service through
     * ctx.reflect.provide - measured live: dsh-univer-office defines
     * `UniverService extends Service` (the host cordis), whose constructor
     * ends with `self.ctx.reflect.provide(name, self, check)` and died here
     * with "Cannot read properties of undefined (reading 'provide')" until
     * this view existed. The three-argument call shape is accepted; the
     * auto-dispose-on-fiber-unload the third argument carries does not apply
     * because there is no fiber, so a provided service lives until dispose()
     * tears the scope down - the same lifetime provide() above gives.
     */
    reflect: {
      provide (name, value) { services[name] = value; return value },
      define (name, value) { services[name] = value; return value },
    },
    /**
     * Cordis ctx.plugin(p, config) mounts a further plugin - measured live:
     * dsh-univer-office rejected with "ctx.plugin is not a function" because
     * its apply() composes helper plugins that way. Mirror the resolve() step of
     * the real cordis: a function is the apply itself (inject may ride on
      * `.inject`), an object contributes `.apply`. The declared names gate the
      * call the same way inject does, the child scope resolves the snapshot's
      * services the way a cordis child context does, and a provided service
      * lands in the shared store so the rest of the load can see it.
     *
     * A spawned apply that rejects must not escape as an unhandled rejection:
     * the same measured failure that the inject path guards against. The
     * returned promise rethrows for an awaiting caller while also carrying an
     * internal catch that logs - attaching a handler on the *same* promise keeps
     * a spawned-and-forgotten failure visible without killing the host, and
     * does not change what an awaiting caller receives.
     */
    plugin (p, config) {
      const resolved = typeof p === 'function' ? p : (p && typeof p === 'object' ? p : null)
      const applyFn = resolved === null ? undefined : (typeof resolved === 'function' ? resolved : resolved.apply)
      if (typeof applyFn !== 'function') throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + (resolved === null ? String(p) : typeof applyFn))
      const declared = Array.isArray(resolved.inject) ? resolved.inject.slice() : []
      if (declared.some((n) => services[n] === undefined)) return undefined
      const child = {}
      // A cordis plugin child resolves the parent's services through the
      // injector, so a spawned helper that declared no inject still sees the
      // snapshot (measured: the first version handed the child only the
      // declared names and loader-unit's nested-plugin check crashed on
      // c.tools.register - "Cannot read properties of undefined"). The
      // declared names still gate whether the helper runs at all.
      for (const [n, v] of Object.entries(services)) child[n] = v
      for (const k of ['effect', 'on', 'once', 'emit', 'inject', 'provide', 'plugin', 'missing', 'reflect']) child[k] = base[k]
      for (const k of TIMER_KEYS) child[k] = base[k]
      children.push(child)
      // cordis instantiates a plugin given as a class (a Service subclass is the
      // normal shape); calling it as a function is what produced "Class constructor
      // X cannot be invoked without 'new'" for npm:dsh-browser-playwright-codex and
      // npm:@wenaixi/dsh-ponytail. An apply-function plugin is still called.
      const isClass = typeof resolved === 'function' && /^\s*class[\s{]/.test(Function.prototype.toString.call(resolved))
      const out = isClass ? new resolved(child, config) : applyFn(child, config)
      if (out && typeof out.then === 'function') {
        const chained = out.then(() => ({ dispose () {} }), (e) => { throw e })
        chained.catch((e) => { log('detached plugin rejected: ' + String((e && e.message) || e).slice(0, 120)) })
        return chained
      }
      return { dispose () {} }
    },
  }
  for (const [k, v] of Object.entries(services)) base[k] = v
  Object.assign(base, timerHelpers)

  const scope = new Proxy(base, {
    get (target, prop) {
      if (prop in target) return target[prop]
      // Unknown names answer undefined rather than reaching for a dead fiber.
      if (typeof prop === "symbol") return undefined
      return undefined
    },
    // Assignments land on the target. Returning true without writing looked
    // harmless and was not: scope.dispose = fn was accepted, discarded, and a
    // caller asking for scope.dispose() got "not a function".
    set (target, prop, value) { target[prop] = value; return true },
  })

  scope.dispose = () => {
    const pending = cleanups.splice(0)
    for (const fn of pending) {
      try { const r = fn(); if (r && typeof r.then === "function") r.then(null, () => {}) } catch { /* one bad cleanup must not block the rest */ }
    }
    for (const stop of [...timers]) { try { stop() } catch { /* already stopped */ } }
    children.length = 0
    return pending.length
  }
  return scope
}
