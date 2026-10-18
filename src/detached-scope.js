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
  const services = Object.assign(Object.create(null), snapshot || {})
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
      const child = {}
      for (const n of list) child[n] = services[n]
      child.effect = effectShim
      child.inject = base.inject.bind(base)
      child.on = base.on
      child.once = base.once
      child.emit = base.emit
      children.push(child)
      // Propagate a throwing callback: a bundle that fails while registering is
      // the bundle problem and the loader reports it with the bundle name.
      // Swallowing it here is how a broken load would read as a successful empty
      // one - the exact class of bug this bridge has been chasing all day.
      callback(child)
      return { dispose () {} }
    },
    provide (name, value) { services[name] = value; return value },
  }
  for (const [k, v] of Object.entries(services)) base[k] = v

  const scope = new Proxy(base, {
    get (target, prop) {
      if (prop in target) return target[prop]
      // Unknown names answer undefined rather than reaching for a dead fiber.
      if (typeof prop === "symbol") return undefined
      return undefined
    },
    set () { return true },
  })

  scope.dispose = () => {
    const pending = cleanups.splice(0)
    for (const fn of pending) {
      try { const r = fn(); if (r && typeof r.then === "function") r.then(null, () => {}) } catch { /* one bad cleanup must not block the rest */ }
    }
    children.length = 0
    return pending.length
  }
  return scope
}
