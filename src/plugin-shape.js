/**
 * What a bundle module contributes, resolved once for every caller.
 *
 * cordis accepts three shapes for a plugin: a function used as apply(), an
 * object carrying .apply, and a class it instantiates. A runtime bundle module
 * is one level further out - the shape arrives as a module namespace, so the
 * value lives on .apply, .default, or .default.apply.
 *
 * Reading that wrong is invisible until a real package hits it. Measured:
 * npm:dsh-deja 0.23.1 exports ONLY `export default apply`, where the function
 * is literally named apply. `(mod.apply) || (mod.default && mod.default.apply)`
 * therefore fell through to `Function.prototype.apply` - a function, so every
 * typeof guard passed - and calling it produced "Function.prototype.apply was
 * called on undefined, which is undefined and not a function", reported as the
 * bundle's own failure. @yadsh/dsh-qa-surface failed the same way in the same
 * batch; both are correct packages.
 *
 * The rule that prevents it: never read a property off a value without checking
 * that the value is the kind that can carry it. A function's .apply is
 * Function.prototype.apply, and a class's .apply is the same. So resolve the
 * candidate first, then decide how to invoke it.
 *
 * @module src/plugin-shape.js
 */

/**
 * Is this function actually a class?
 *
 * cordis constructs a class plugin and calls a function plugin; calling a class
 * throws "Class constructor X cannot be invoked without 'new'". The check is on
 * the source text because that is the only reliable signal left after
 * transpilation: `typeof` reports 'function' for both.
 * @param {any} fn
 */
export function isClassFunction (fn) {
  if (typeof fn !== 'function') return false
  return /^\s*class[\s{]/.test(Function.prototype.toString.call(fn))
}

/**
 * @typedef {{kind:'apply'|'class', inject:string[], construct:(scope:any, config:any)=>any, source:string}} PluginShape
 */

/**
 * Describe one plugin value (function, class, or object with .apply).
 * @param {any} plugin
 * @param {string} [source] where the value came from, for diagnostics only
 * @returns {PluginShape|null}
 */
export function describePlugin (plugin, source = 'plugin') {
  if (plugin == null) return null
  if (typeof plugin === 'function') {
    const inject = Array.isArray(plugin.inject) ? plugin.inject.slice() : []
    return isClassFunction(plugin)
      ? { kind: 'class', inject, source, construct: (scope, config) => new plugin(scope, config) }
      : { kind: 'apply', inject, source, construct: (scope, config) => plugin(scope, config) }
  }
  if (typeof plugin === 'object' && typeof plugin.apply === 'function') {
    const inject = Array.isArray(plugin.inject) ? plugin.inject.slice() : []
    return isClassFunction(plugin.apply)
      ? { kind: 'class', inject, source, construct: (scope, config) => new plugin.apply(scope, config) }
      // An object plugin's apply expects the object as `this`; cordis calls it
      // that way, so binding here keeps a bundle that reads this.config working.
      : { kind: 'apply', inject, source, construct: (scope, config) => plugin.apply(scope, config) }
  }
  return null
}

/**
 * Resolve a bundle module namespace into the plugin it contributes.
 *
 * Order matters and mirrors what the host does when it mounts a bundle from a
 * profile: the named export is cordis' own convention and wins, then a default
 * export as-is, then a default export object carrying .apply.
 *
 * @param {any} mod the imported module namespace
 * @returns {PluginShape|null} null when the module contributes no plugin at all
 */
export function bundlePlugin (mod) {
  if (!mod) return null
  // `typeof mod.apply === 'function'` is the guard that was missing: on a module
  // namespace it is safe (a namespace has no Function.prototype), but the same
  // expression was applied to `mod.default`, which is where it broke.
  if (typeof mod.apply === 'function') return describePlugin(mod.apply, 'export apply')
  const d = mod.default
  if (typeof d === 'function') return describePlugin(d, 'export default')
  if (d && typeof d === 'object' && typeof d.apply === 'function') {
    return describePlugin(d, 'export default.apply')
  }
  return null
}
