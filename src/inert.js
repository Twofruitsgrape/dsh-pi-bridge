/**
 * The inert stand-in handed to a foreign plugin for a host binding the bridge
 * cannot implement.
 *
 * It has to survive what plugin code actually does with a binding it imports:
 * call it, chain off it, await it, coerce it to a string, extend it as a class,
 * and construct it. A stub that answers undefined for 'prototype' breaks
 * 'class X extends stub()', which real bundles do; one that answers a non-path
 * string for a path helper breaks path.join(). Both are recorded, never thrown.
 *
 * @module src/inert.js
 */

export function inert (label) {
  const fn = function () { return inert(label + '()') }
  const proto = fn.prototype
  return new Proxy(fn, {
    get (target, p) {
      if (p === Symbol.toPrimitive || p === 'toString') return () => '[dsh-pi-bridge stub: ' + label + ']'
      if (p === 'then' || typeof p === 'symbol') return undefined
      if (p === 'prototype') return proto
      if (p === 'name' || p === 'length') return target[p]
      if (p === 'call' || p === 'apply' || p === 'bind') return target[p].bind(target)
      return inert(label + '.' + String(p))
    },
    apply () { return inert(label + '()') },
    construct () { return { __bridgeStub: label } },
    set () { return true },
  })
}

export default inert
