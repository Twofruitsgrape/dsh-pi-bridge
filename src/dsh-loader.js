/**
 * Load a DSH plugin bundle at runtime, from inside a DSH process.
 *
 * Verified against a real host: a bundle installed by the plugin manager is a
 * symlink under the profile's node_modules, so a bare specifier such as
 * '@deepseek-ai/dsh-tools' cannot resolve from it (MODULE_NOT_FOUND), while the
 * build's own node_modules are reachable by absolute path from
 * process.execPath through the Electron-patched fs. So bare host specifiers are
 * rewritten to file URLs of the host's genuine modules - not stubs - and the
 * result is imported and applied against the live ctx. Relative and node:
 * specifiers are untouched, so a bundle still reads its own files normally.
 *
 * @module src/dsh-loader.js
 */
import { createRequire, isBuiltin } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { bundlePlugin } from './plugin-shape.js'
import { guardConnection } from './service-guard.js'

/** Specifier families the running build supplies. */
const HOST_PREFIXES = ['@deepseek-ai/', '@deepseek-harness/', 'cordis', 'schemastery', '@cordiverse/']

export function isHostSpecifier (s) {
  return HOST_PREFIXES.some((p) => s === p || s.startsWith(p.endsWith('/') ? p : p + '/'))
}

/**
 * The installed build's own node_modules roots.
 *
 * Two layouts exist in the wild: the 0.2.1 desktop ships the runtime UNPACKED at
 * resources/app/, while older installs keep it in resources/app.asar. Measured on
 * 0.2.1-rc.3: app.asar was gone and the asar-only root list resolved nothing, so
 * every bare '@deepseek-ai/*' import from a bundle would have failed with
 * MODULE_NOT_FOUND - the exact failure this loader exists to prevent.
 */
export function hostModulesRoots (execPath = process.execPath) {
  const exe = String(execPath || '')
  if (!exe) return []
  const resources = path.join(path.dirname(exe), 'resources')
  return [
    path.join(resources, 'app', 'dsh', 'node_modules'),
    path.join(resources, 'app.asar', 'dsh', 'node_modules'),
    path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'),
  ]
}

/** Resolve one host specifier to a real module file inside the running build. */
export function hostEntry (specifier, roots = hostModulesRoots()) {
  for (const r of roots) {
    try { return createRequire(path.join(r, 'noop.js')).resolve(specifier) } catch { /* next root */ }
  }
  return null
}

function toUrl (file) {
  const s = String(file).replace(/\\/g, '/')
  return (/^[A-Za-z]:\//.test(s) ? 'file:///' + s : 'file://' + s)
}

/**
 * Rewrite bare host specifiers in a source text to file URLs of the host's own
 * modules. Returns the rewritten code and what it mapped, so a caller can
 * report exactly which host packages the bundle ended up using.
 * @param {string} source
 * @param {(spec:string)=>string|null} resolveSpec
 */
export function rewriteHostSpecifiers (source, resolveSpec = hostEntry, options = {}) {
  const mapped = []
  // Three shapes carry a specifier: from 'x', import('x'), and a bare side-effect
  // import 'x' with no from at all. The third was missing, so a bundle whose
  // hooks.js opened with import '@deepseek-ai/dsh-session'; kept the bare name and
  // node could not resolve it from a cache copy - reported as the package wanting
  // a package the product does not ship, when the product ships it and I had just
  // failed to rewrite the one line that asked for it. (@furongjun1999/dsh-memory,
  // measured: the specifier resolves fine from the build's own node_modules.)
  let code = source.replace(/(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g, (whole, head, quote, spec) => {
    // A plain builtin ('fs/promises', 'path') must also stay untouched: hostEntry
    // resolves a builtin to its own bare name and toUrl would then publish a fake
    // "file://path" import URL. Measured in the hot-100 DSH batch, chunk 1: two
    // bundled real plugins (dsh-plugin-ops-core, npm:dsh-plan-and-execute) import
    // path/fs/promises bare and died with "Cannot find module '\\path\\'" until
    // this guard let node resolve builtins natively.
    if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('file:') || isBuiltin(spec)) return whole
    const file = resolveSpec(spec)
    if (!file) return whole
    mapped.push({ specifier: spec, target: file })
    return head + '"' + toUrl(file) + '"'
  })
  // A cached copy may already carry a host URL written by the same rewriter
  // under the layout the host had at the time. 0.2.1-rc.3 moved the runtime
  // out of app.asar, and every cached file kept an app.asar URL that no
  // longer exists (710 files measured; the first load after the upgrade died
  // on MODULE_NOT_FOUND). Such a URL is invisible to the bare-specifier pass
  // above, so repoint it at the running build. With no root on disk the URL
  // is left exactly as it was: guessing a path would be worse than the error.
  const roots = (options && options.hostRoots) || hostModulesRoots()
  const currentRoot = roots.find((r) => existsSync(r))
  if (currentRoot) {
    code = code.replace(/(['"])file:\/\/\/[^'"\n]*?\/resources\/(?:app\.asar\.unpacked|app\.asar|app)\/dsh\/node_modules\/([^'"\n]+)\1/g,
      (whole, quote, rest) => {
        const target = toUrl(currentRoot) + '/' + rest
        const seg = rest.split('/')
        mapped.push({ specifier: seg[0].startsWith('@') ? seg.slice(0, 2).join('/') : seg[0], target, healed: true })
        return quote + target + quote
      })
  }
  return { code, mapped }
}

/**
 * Rewrite every JavaScript file in a bundle directory, in place.
 *
 * Rewriting only the entry and importing it from another directory broke two real
 * bundles, in both directions: their relative imports ('./compositions.js') then
 * resolved next to the rewritten copy instead of inside the package, and host
 * specifiers imported by a *deeper* file ('lib/dsh/preset-installation.js' pulling
 * in '@deepseek-ai/schemastery') were never rewritten at all. So the whole tree
 * gets transformed and stays where it is: relative imports keep working because
 * the files never moved, and no specifier is missed because nothing is special
 * about the entry.
 *
 * The directory is the bridge's own cache copy, never the user's installed
 * bundle. Re-running is harmless: a rewritten specifier is a file: URL, which the
 * rewriter leaves alone.
 *
 * @param {string} dir bundle root inside the cache
 * @param {(spec:string)=>string|null} resolveSpec
 * @param {{log?:(m:string)=>void, limit?:number, cacheRoot?:string}} [opts]
 * @returns {{files:number, mapped:string[], refused?:boolean}}
 */
export function rewriteBundleTree (dir, resolveSpec = hostEntry, opts) {
  const log = (opts && opts.log) || (() => {})
  const limit = (opts && opts.limit) || 4000
  // Refuse to touch anything outside the bridge's own cache. Rewriting in place is
  // what keeps a bundle's relative imports working, so the directory handed here
  // must be the copy the bridge made, never a directory someone owns: a plugin
  // author pointing dsh_install at their own working tree would otherwise have
  // their source files replaced with host-module URLs. Measured the hard way - an
  // offline test that passed a repository path rewrote the committed fixture.
  // The cache root is recomputed here rather than imported from resolve.js: that
  // module reaches this one through the entry points, and a cycle would make both
  // unreadable. The same expression, and callers may pass their own.
  const cacheRoot = (opts && opts.cacheRoot) || process.env.DSH_PI_BRIDGE_HOME || path.join(os.homedir(), ".dsh-pi-bridge")
  const inside = cacheRoot && path.resolve(dir).startsWith(path.resolve(cacheRoot) + path.sep)
  if (!inside) {
    log('refusing to rewrite outside the bridge cache: ' + dir)
    return { files: 0, mapped: [], refused: true }
  }
  const mapped = new Set()
  let files = 0
  /**
   * A third-party specifier gets one fallback the host families never needed:
   * the bundle's own tree first, then the running build. Measured live:
   * dsh-mcp-connector declares zod as a peer dependency - the cache install
   * deliberately skips peers (--legacy-peer-deps; in a native install they are
   * the host's job), the specifier is third-party so the family prefixes did
   * not rewrite it, and the load died with "Cannot find package 'zod'" although
   * the running build ships a genuine zod in its own node_modules. This mirrors
   * what a profile install would hand the bundle: its own copy when it has one,
   * the build's when it does not, and a real MODULE_NOT_FOUND when neither
   * exists - never a stub.
   */
  const peerPackageName = (spec) => {
    const seg = spec.split('/')
    return seg[0].startsWith('@') ? seg.slice(0, 2).join('/') : seg[0]
  }
  const withPeerFallback = (spec) => {
    if (isBuiltin(spec)) return null // builtins resolve natively, never into toUrl
    if (isHostSpecifier(spec)) return resolveSpec(spec)
    if (existsSync(path.join(dir, 'node_modules', peerPackageName(spec)))) return null
    return resolveSpec(spec)
  }
  const walk = (current, depth) => {
    if (depth > 12 || files >= limit) return
    let entries = []
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        // node_modules inside the copy must be walked too: a bundle's nested
        // packages carry specifiers that only the rewrite can resolve. Measured
        // in the hot-100 DSH batch: zed-acp's npm-installed
        // @agentclientprotocol/sdk dist imports bare 'zod' (third-party; the
        // build ships one), wwrs-voice's nested @deepseek-ai/dsh-* files import
        // bare '@deepseek-ai/cordis' (family). Skipping the subtree left both
        // specifiers bare and both bundles died with MODULE_NOT_FOUND although
        // withPeerFallback had exactly what they asked for. Dot-directories
        // stay skipped. Idempotent: already-rewritten specifiers are file:
        // URLs, which rewriteHostSpecifiers leaves alone.
        if (e.name.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!/\.(m?js|cjs)$/.test(e.name) || e.name.endsWith('.map')) continue
      let source = ''
      try { source = readFileSync(full, 'utf8') } catch { continue }
      files++
      if (!/from\s+['"]|import\s*\(|^\s*import\s+['"]/m.test(source)) continue
      const { code, mapped: hits } = rewriteHostSpecifiers(source, withPeerFallback, opts)
      if (!hits.length) continue
      for (const h of hits) mapped.add(h.specifier)
      try { writeFileSync(full, code, 'utf8') } catch (err) { log('could not rewrite ' + e.name + ': ' + String(err && err.code)) }
    }
  }
  walk(dir, 0)
  return { files, mapped: [...mapped] }
}

/**
 * Resolve a bundle's Config schema into the runtime config object a host boot
 * would have handed apply().
 *
 * A boot binds config from the profile through the plugin's Config schema; a
 * runtime load has neither, and passing the schema through raw breaks every
 * bundle that reads config.<field> instead of calling it. Measured on
 * npm:dingpenghui/agnes-image: config.defaultSize reached a tool's JSON Schema
 * `default` annotation as a schema node, and the host refused the whole
 * registration with 'schema.properties.size.default annotation must be lossless
 * JSON data' - an error that names the tool, not the cause.
 *
 * Schemastery schemas are callable functions (schema({}) resolves every
 * default) and zod-style schemas resolve through .parse({}). A schema that
 * requires a value no default supplies throws; that bundle keeps the raw schema
 * argument so its own diagnostics still surface unchanged.
 * @param {any} raw mod.default.config as the bundle exported it
 * @returns {any} resolved defaults, or raw when the schema cannot resolve {}
 */
export function resolveBundleConfig (raw) {
  if (raw == null) return {}
  try {
    if (typeof raw === 'function') {
      const resolved = raw({})
      if (resolved !== null && typeof resolved === 'object') return resolved
    } else if (typeof raw.parse === 'function') {
      const resolved = raw.parse({})
      if (resolved !== null && typeof resolved === 'object') return resolved
    }
  } catch { /* the schema demands values a runtime load cannot supply */ }
  return raw
}

/**
 * Load one bundle directory against a live DSH scope.
 * @param {string} dir bundle root
 * @param {any} ctx the scope this plugin was applied with
 * @param {{log?:(m:string)=>void, entry?:(dir:string,pkg:any)=>Promise<string|null>, registered?:Set<string>, resolveSpec?:(s:string)=>string|null}} opts
 *        registered: tool names this session already has. The host rejects a
 *        duplicate ("tool X is already registered", measured on a live boot), and
 *        a second request for a bundle the user already installed is the normal
 *        case, not an error: pi asking to use what DSH already loaded.
 * @returns {Promise<{name:string, tools:any[], commands:any[], mapped:any[], error?:string}>}
 */
export async function loadDshBundle (dir, ctx, opts) {
  const log = (opts && opts.log) || (() => {})
  const { classify, dshEntry } = await import('./manifest.js')
  const info = await classify(dir)
  const entryFile = (opts && opts.entry) ? await opts.entry(dir, info.pkg) : await dshEntry(dir, info.pkg)
  if (!entryFile) return { name: info.name, tools: [], commands: [], mapped: [], error: 'no DSH entry module found' }

  const tools = []
  const commands = []
  /** Skill providers the bundle registers: real capability, just not callable. */
  /** Whether the bundle used ctx.inject at all: registrations may be pending. */
  const flags = { deferred: false, contained: [] }
  const skillCount = { count: 0 }
  /** Names the host refused because they already exist; reported, not fatal. */
  const alreadyPresent = []
  /** Registrations the host refused because the name was taken. */
  const conflicts = []
  /** Callable tool definitions this load registered, keyed by name. */
  const callable = new Map()
  const registered = (opts && opts.registered) || new Set()
  // Recording wrappers so the caller learns what the bundle registered, while
  // the registrations themselves go to the real host.
  const serviceGet = serviceGetter(ctx)
  const scope = observeScope(ctx, tools, commands, skillCount, registered, alreadyPresent, conflicts, flags, serviceGet)
  try {
    const tree = rewriteBundleTree(dir, opts.resolveSpec || hostEntry, { log })
    if (tree.mapped.length) log('rewrote ' + tree.files + ' file(s), host specifiers: ' + tree.mapped.join(', '))
    const mod = await import(pathToFileURL(entryFile).href)
    // What the module contributes, resolved without reading a property off a
    // value that cannot carry it. `mod.default.apply` on a default-exported
    // FUNCTION is Function.prototype.apply - a function, so every typeof guard
    // passed, and calling it read as the bundle's own failure. Measured on
    // npm:dsh-deja (export default apply) and npm:@yadsh/dsh-qa-surface in the
    // same pi->DSH batch; both packages are correct.
    const shape = bundlePlugin(mod)
    if (!shape) {
      return { name: info.name, tools: [], commands: [], skills: 0, mapped: [], error: 'no DSH apply() exported from ' + path.basename(entryFile) + ': this bundle contributes configuration or a host bridge rather than a plugin module, so there is nothing to load at runtime' }
    }
    /**
     * A bundle is applied in a scope built for IT, not for the bridge.
     *
     * Cordis resolves a service out of the fiber that declared it, so reading
     * ctx.llm from a fiber that only injected 'tools' throws 'cannot get property
     * "llm" without inject' - measured on a live session against four real
     * bundles. The host's own mechanism for reaching services on demand is
     * ctx.inject(names, fn), which opens a child scope carrying exactly those
     * names; the bundle's declared inject list is what it needs, plus the ones it
     * registers into. This is also how the bridge mounts skills for itself.
     */
    /**
     * Ask for the services the bundle declares, then for the two this bridge
     * observes, then fall back - and never pretend a refusal was a success.
     *
     * Cordis resolves a service out of the fiber that declared it, so reading
     * ctx.llm from a fiber that only injected 'tools' throws 'cannot get property
     * "llm" without inject' - measured on a live session against four real
     * bundles. The host's mechanism for reaching services on demand is
     * ctx.inject(names, fn), which opens a child scope carrying exactly those
     * names.
     *
     * Adding tools and commands to every request looked harmless and was not: a
     * profile that does not compose 'commands' makes ctx.inject return undefined
     * for the whole request, so a bundle needing only tools never ran apply() and
     * the report came back 'tools: none'. Caught offline by the reload test, which
     * is why the wider request is only the first attempt, not the only one.
     */
    const declared = shape.inject.slice()
    if (!declared.length) {
      if (Array.isArray(mod.inject)) declared.push(...mod.inject)
      else if (mod.default && Array.isArray(mod.default.inject)) declared.push(...mod.default.inject)
    }
    const wider = declared.slice()
    for (const need of ['tools', 'commands']) if (!wider.includes(need)) wider.push(need)
    const bundleConfig = resolveBundleConfig((mod.default && mod.default.config) || mod.Config || mod.config || {})
    const attempts = wider.length === declared.length ? [wider] : [wider, declared]
    if (typeof ctx.inject === 'function') {
      let composed = false
      let lastError = null
      // The frames behind a refused load, kept only under DSH_PI_BRIDGE_DEBUG=1.
      let debugStack = null
      // Why the attempt stopped matters, and reading every stop the same way
      // produced two wrong reports at once: a bundle that threw inside its own
      // apply() was blamed on a missing service, AND the loop then retried it with
      // a narrower list, so the bundle registered its tools twice (measured:
      // 'at_first' appeared twice in the host registry). The callback running at all
      // is the signal - it means the scope DID compose what was asked, so anything
      // that goes wrong afterwards is the bundle's own failure and must be reported
      // as such, not retried. Only a callback that never ran is a refusal.
      let bundleFailure = null
      for (const names of attempts) {
        let ran = false
        try {
          await ctx.inject(names, (inner) => {
            ran = true
            return shape.construct(observeScope(inner, tools, commands, skillCount, registered, alreadyPresent, conflicts, flags, serviceGet), bundleConfig)
          })
        } catch (e) {
          if (ran) { bundleFailure = e; break }
          lastError = e
          continue
        }
        composed = ran
        if (ran) break
      }
      if (bundleFailure) {
        // Registered before it threw still counts: a bundle that half-loaded is
        // reported with what it gave and the error that stopped it, rather than as
        // a clean refusal that hides a real bug in the package.
        for (const t of tools) callable.set(t.name, t.def)
        return {
          name: info.name, tools, commands, skills: skillCount.count, mapped: [], deferred: flags.deferred,
          callable,
          bundleError: true,
          debugStack: process.env.DSH_PI_BRIDGE_DEBUG === '1' && bundleFailure.stack
            ? String(bundleFailure.stack).split('\n').slice(1, 7).map((s) => s.trim()).join(' <- ') : null,
          error: 'its own apply() failed: ' + String((bundleFailure && bundleFailure.message) || bundleFailure).slice(0, 200),
        }
      }
      if (!composed) {
        const msg = String((lastError && (lastError.message || lastError)) || '')
        if (lastError && process.env.DSH_PI_BRIDGE_DEBUG === '1' && lastError.stack) {
          // A cause this bridge cannot name from the message alone has to show its
          // frames: seven published bundles failed with 'cannot create effect on
          // inactive context', which this file's attribution reported as 'this
          // profile does not compose <service>'. Four wrong guesses in a row is
          // the signal that the message was never going to be enough.
          debugStack = String(lastError.stack).split('\n').slice(1, 9).map((s) => s.trim()).join(' <- ')
        }
        if (lastError) {
          // Three causes read alike unless the message is inspected, and guessing
          // wrong sends the user off to fix something that is not broken:
          // - config.<field>.get(): values the host binds from the bundle's Config
          //   schema and patch row, which a runtime load cannot fabricate
          //   (dsh-plugin-model-proxy);
          // - 'has been registered': the session already holds those names, so this
          //   bundle is already loaded and callable (three published packages on a
          //   real pi run were reported as needing a service that was in fact
          //   present the whole time);
          // - otherwise the named services are genuinely not composed here.
          const configBound = /Cannot read properties of undefined \(reading 'get'\)|is not a function|reading 'set'/.test(msg)
          const alreadyRegistered = /has been registered|already registered|is already registered|duplicate/i.test(msg)
          return {
            name: info.name, tools: [], commands: [], skills: 0, mapped: [], deferred: flags.deferred,
            alreadyLoaded: alreadyRegistered,
            debugStack,
            error: configBound
              ? 'needs configuration the host binds from its Config schema and patch row (apply() reads config.<field>.get()), which a runtime load cannot fabricate - mount it as a profile bundle instead: ' + msg.slice(0, 120)
              : alreadyRegistered
                ? 'already loaded in this session (' + msg.slice(0, 110) + ')'
                : 'needs ' + (typeof ctx.missing === 'function' ? ctx.missing(declared).join(', ') : declared.join(', ')) + ' composed here: ' + msg.slice(0, 140),
          }
        }
        // No exception, but the callback never ran: the scope declined to compose
        // something. Report the names it actually cannot supply rather than every
        // name the bundle declared - a scope offering tools and skills but not fs
        // should send the user to fs, not to the two services that were fine. A
        // scope without a missing() to ask about still gets the declared list.
        const absent = typeof ctx.missing === 'function' ? ctx.missing(declared) : []
        const named = absent.length ? absent.join(', ') : (declared.join(', ') || 'the services it declares')
        return {
          name: info.name, tools: [], commands: [], skills: 0, mapped: [], deferred: flags.deferred,
          missing: absent,
          error: 'this session does not compose ' + named + ', so its registrations would go nowhere'
            + ' (asked for: ' + (declared.join(', ') || 'nothing in particular') + ')',
        }
      }
    } else {
      await shape.construct(scope, bundleConfig)
    }

    for (const t of tools) callable.set(t.name, t.def)
    // A bundle's registrations and its service calls both continue after apply()
    // resolves. Measured on npm:@michengai/dsh-automation: the load answered
    // ok:true in 540ms and the session died right after, because the failing
    // connection.rpc.handle ran in the bundle's own continuation. Reporting the
    // load before those continuations have run means reporting the wrong thing -
    // so give them a bounded moment to land, then read what the guard captured.
    const settleMs = Number.isFinite(opts && opts.settleMs) ? opts.settleMs : 250
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs))
    // A detached scope carries the failures its own shims contained (an async
    // effect factory that rejected, say). Collect them into the same report so
    // "the session survived" also says what it survived.
    if (ctx && Array.isArray(ctx.containedFailures)) {
      for (const f of ctx.containedFailures) if (!flags.contained.includes(f)) flags.contained.push(f)
    }
    // A reused tool is still callable: its definition came from the first load,
    // which is why the caller keeps one shared registry rather than this map.
    const contained = flags.contained
    return {
      name: info.name,
      skills: skillCount.count,
      // Contained is not the same as succeeded. The bundle made a call that
      // would have ended the session, so the load carries the reason instead of
      // reporting a clean success that hides it.
      ...(contained.length
        ? { contained, error: 'its own ' + contained[0].call + ' failed and was contained: ' + contained[0].error }
        : {}),
      // Strip the definition before returning it across a boundary.
      tools: tools
        .filter((t) => !alreadyPresent.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      reused: [...alreadyPresent],
      deferred: flags.deferred,
      conflicts,
      commands,
      mapped: tree.mapped,
      callable,
    }
  } catch (e) {
    return { name: info.name, tools: [], commands: [], mapped: [], error: String((e && e.message) || e).slice(0, 300) }
  }
}

/**
 * Resolve a service the way cordis's own ctx.get() does - from the store, with
 * no inject requirement.
 *
 * The scope cordis hands an inject() callback is not a full Context: measured on
 * a live session, it carries tools/commands but no get(). Bundle execute() blocks
 * read optional services through ctx.get (npm:dingpenghui/agnes-image resolves
 * 'credentials' and 'attachments' that way), so without this every such call
 * dies with 'ctx.get is not a function'. The root context this plugin runs in IS
 * a Context; a service the deployment does not compose stays undefined and the
 * bundle reports that in its own words.
 * @param {any} ctx the scope loadDshBundle was applied with
 * @returns {((name:string)=>any)|undefined}
 */
function serviceGetter (ctx) {
  const get = ctx && typeof ctx.get === 'function' ? ctx.get : null
  if (!get) return undefined
  return (name) => {
    try { return get.call(ctx, name) } catch { return undefined }
  }
}

/**
 * A scope view that records registrations without touching the real scope.
 *
 * The host scope forbids property assignment ("cannot set property "tools" in
 * multiple fibers", measured on a live DSH boot), so this cannot copy or
 * subclass it. A get-only Proxy intercepts the two services we want to observe
 * and forwards everything else, including the underlying register calls, so the
 * bundle registers for real and the host accepts it exactly as it accepts a
 * boot-time plugin.
 */
function observeScope (ctx, tools, commands, skillCounter, registered, alreadyPresent, conflicts, flags, serviceGet) {
  const recording = (kind, sink) => {
    const real = ctx[kind]
    return new Proxy(real, {
      get (target, prop) {
        if (prop === 'register') {
          return (def) => {
            const name = String((def && def.name) || 'unnamed')
            if (kind === 'tools') {
              if (registered.has(name)) { alreadyPresent.push(name); return { dispose () {} } }
              sink.push({ name, description: String((def && def.description) || ''), parameters: (def && def.parameters) || null, def })
            }
            else sink.push({ name, description: String((def && def.description) || '') })
            try {
              return target.register(def)
            } catch (e) {
              // The host throws on a name it already has, and a bundle that
              // collides with a mounted plugin is the normal case, not a broken
              // one. Losing that one tool must not abort the whole bundle, so the
              // conflict is reported and registration of the rest continues.
              conflicts.push({ name, reason: String((e && e.message) || e).slice(0, 140) })
              return { dispose () {} }
            }
          }
        }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return new Proxy(ctx, {
    get (target, prop) {
      // A bundle registers from inside its own ctx.inject callback all the
      // time - dsh-super-code and dsh-thinking-levels both do - and the host hands
      // that callback a scope of its own, not the one this loader handed to apply().
      // Wrapping only the apply() scope therefore misses every deferred tool: the
      // host has it, the bridge reports none, and the other host is told the bundle
      // contributed nothing. So the callback's argument gets wrapped too.
      if (prop === 'inject') {
        const inject = target.inject
        if (typeof inject !== 'function') return inject
        return (names, fn) => {
          flags.deferred = true
          return inject.call(target, names, (inner) => fn(observeScope(inner, tools, commands, skillCounter, registered, alreadyPresent, conflicts, flags, serviceGet)))
        }
      }
      if (prop === 'get') {
        const own = target.get
        const read = typeof own === 'function' ? own.bind(target) : serviceGet
        if (typeof read !== 'function') return read
        // get('connection') is the other way a bundle reaches the same service,
        // and a guard on the property alone would leave that door open.
        return (name) => {
          const value = read(name)
          return name === 'connection' && value ? guardConnection(value, flags.contained) : value
        }
      }
      // The one service whose misuse takes the whole session with it: the
      // bundle calls connection.rpc.handle(), the HOST's own implementation
      // throws on a fiber it never injected webServer into, and because that
      // happens on the host's registration path the process exits. Measured on
      // npm:@michengai/dsh-automation 1.0.10. Guarding the value the bundle is
      // handed is what turns "host is gone" into "this bundle's call failed".
      if (prop === 'connection') {
        let real
        try { real = target.connection } catch { return undefined }
        return real ? guardConnection(real, flags.contained) : real
      }
      if (prop === 'tools' && target.tools) return recording('tools', tools)
      if (prop === 'commands' && target.commands) return recording('commands', commands)
      if (prop === 'skills' && target.skills) {
        return new Proxy(target.skills, {
          get (st, sp) {
            if (sp === 'registerProvider') {
              return (fn) => { skillCounter.count++; return st.registerProvider(fn) }
            }
            const v = st[sp]
            return typeof v === 'function' ? v.bind(st) : v
          },
        })
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
    // Never write through to the host scope.
    set () { return false },
  })
}

/** Kept for tests: read a file if it exists, else null. */
export async function readIfExists (p) {
  try { return await readFile(p, 'utf8') } catch { return null }
}
