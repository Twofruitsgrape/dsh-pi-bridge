/**
 * Contain a service call that would otherwise kill the host process.
 *
 * WHY THIS EXISTS, measured on a live 0.2.1-rc.3 session with
 * DSH_PI_BRIDGE_DEBUG=1 and npm:@michengai/dsh-automation 1.0.10:
 *
 *   dsh: fatal load failure: Error: cannot get property "webServer" without inject
 *       at Proxy.register      (dsh-client-connection/lib/index.js:871)
 *       at Object.handle       (dsh-client-connection/lib/index.js:727)
 *       at registerAutomationRpc (npm__michengai_dsh-automation/lib/index.js:23013)
 *       at npm__michengai_dsh-automation/lib/index.js:24297
 *
 * The bundle reads `ctx.connection` and calls `.rpc.handle(path, fn)` on it. That
 * call runs inside the HOST's own connection implementation, which reaches for
 * webServer on a fiber this deployment did not inject it into. The throw happens
 * on the host's registration path, so no try/catch of ours around apply() sees
 * it; the host treats it as a fatal load failure and exits.
 *
 * What makes containment possible is where the call is made, not where it throws:
 * the bundle asks OUR scope for `connection`, so the value it calls through is
 * ours to wrap. A guarded wrapper around exactly this one service keeps the
 * failure attributed to the bundle, records the reason, and lets the session
 * live. The load is then reported as failed with that reason - contained is not
 * the same as succeeded, and it must not read that way.
 *
 * Scope, deliberately narrow: only `connection`, and only its rpc registration
 * methods. Wrapping every service call would silently absorb bundle bugs that
 * the host is supposed to reject.
 *
 * @module src/service-guard.js
 */

/** Calls that hand a route to the host's connection layer. */
const GUARDED_RPC_METHODS = new Set(['handle', 'register'])

/**
 * @param {any} connection the real connection service from the snapshot
 * @param {Array<{service:string, call:string, error:string}>} failures sink for contained failures
 * @returns {any} a view that behaves the same until a call throws
 */
export function guardConnection (connection, failures) {
  if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) return connection
  const note = (call, e) => {
    // A bundle can retry the same broken call; the report needs one entry per
    // distinct reason, not a hundred copies of it.
    const error = String((e && e.message) || e).slice(0, 200)
    if (!failures.some((f) => f.call === call && f.error === error)) failures.push({ service: 'connection', call, error })
  }
  /** A promise that rejects later must not escape either. */
  const settle = (value, call) => {
    if (value && typeof value.then === 'function') {
      return value.then(
        (v) => v,
        (e) => { note(call + ' (async)', e); return { dispose () {} } },
      )
    }
    return value
  }
  const wrapRpc = (rpc) => {
    if (!rpc || typeof rpc !== 'object') return rpc
    return new Proxy(rpc, {
      get (target, prop) {
        const value = target[prop]
        if (typeof value === 'function' && GUARDED_RPC_METHODS.has(String(prop))) {
          return (...args) => {
            const call = 'connection.rpc.' + String(prop)
            try {
              return settle(value.apply(target, args), call)
            } catch (e) {
              note(call, e)
              return { dispose () {} }
            }
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return new Proxy(connection, {
    get (target, prop) {
      if (prop === 'rpc') {
        // The getter itself can throw on a fiber that lacks webServer.
        let rpc
        try { rpc = target.rpc } catch (e) { note('connection.rpc', e); return undefined }
        return wrapRpc(rpc)
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
