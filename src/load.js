/**
 * Foreign plugin loading: resolve, mirror, stub, compile, capture.
 *
 * A bridged package is never imported from where it was downloaded. We build a
 * mirror directory whose node_modules carries only what the bridge decides it
 * may see: inert stubs (or real bridge implementations) for host packages, and
 * optionally the package's own published dependencies installed with npm. The
 * mirror is also where TypeScript is compiled to ESM for the DSH side.
 *
 * Two entry conventions are handled here: pi packages expose extension files
 * whose default export is a factory receiving an ExtensionAPI; DSH bundles
 * expose a main module with name/inject/apply.
 *
 * @module src/load.js
 */
import { mkdir, writeFile, rm, cp, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { resolve as resolveSource, installDependencies, PACKAGES_DIR, CACHE_ROOT } from './resolve.js'
import { classify, piEntries, walk, dshEntry } from './manifest.js'
import { scanImports, makeStubs, splitSpecifier, toFileUrl } from './stubs.js'
import { emitBuild, stripAvailable } from './transpile.js'
import { capturePi, captureDsh } from './capture.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHIM_URL = toFileUrl(path.join(HERE, 'typebox-shim.js'))

/** Prepended to every generated stub module. */
const PRELUDE = [
  "import { createTypeShim, createZShim } from '" + SHIM_URL + "'",
  'const __Type = createTypeShim()',
  'const __z = createZShim()',
  // Host path helpers must resolve into the bridge sandbox, never into a real
  // profile: a bridged package that does join(getDshHome(), "sessions") gets a
  // writable scratch root instead of the host directory.
  'const __bridgeHome = () => process.env.DSH_PI_BRIDGE_HOME || (process.env.HOME || process.env.USERPROFILE || ".") + "/.dsh-pi-bridge"',
].join('\n')

/**
 * Bridge implementations handed to the stub writer in place of inert values.
 * Keyed by specifier; a package specifier also covers its subpaths.
 */
const PROVIDED = {
  typebox: { Type: '__Type', default: '__Type' },
  '@sinclair/typebox': { Type: '__Type', default: '__Type' },
  '@deepseek-ai/schemastery': { z: '__z', default: '__z' },
  '@deepseek-ai/dsh-tools': { defineTool: '((o) => o)' },
  '@deepseek-ai/dsh-home-paths': {
    getDshHome: '__bridgeHome',
    resolveDshHome: '__bridgeHome',
    dshHome: '__bridgeHome()',
    default: '__bridgeHome',
  },
  '@earendil-works/pi-coding-agent': {
    Type: '__Type',
    createBashTool: '() => ({ execute: async () => ({ content: [{ type: "text", text: "[dsh-pi-bridge: bash tool is host-side]" }] }) })',
  },
}

/** Host packages the bridge knows how to substitute. */
const KNOWN_HOST_PACKAGES = new Set(Object.keys(PROVIDED).concat([
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
  '@earendil-works/pi-mcp',
  '@earendil-works/pi-codemode',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-agent',
]))

/**
 * Resolve a spec, mirror it, load it, and record the capabilities it registers.
 * @param {string} spec
 * @param {{host?: 'auto'|'pi'|'dsh', refresh?: boolean, installDeps?: boolean,
 *          log?: (m:string)=>void}} [options]
 */
export async function loadForeign (spec, options) {
  const log = (options && options.log) || (() => {})
  const resolved = await resolveSource(spec, {
    log,
    refresh: !!(options && options.refresh),
    cacheOnly: !!(options && options.cacheOnly),
  })
  const info = await classify(resolved.dir)
  const wanted = (options && options.host) || 'auto'
  const host = wanted === 'auto' ? (info.pi && !info.dsh ? 'pi' : info.dsh && !info.pi ? 'dsh' : 'pi') : wanted

  const buildRoot = path.join(CACHE_ROOT, 'build')
  await mkdir(buildRoot, { recursive: true })
  const mirror = path.join(buildRoot, slug(info.name) + '@' + slug(info.version) + '-' + host)
  await rm(mirror, { recursive: true, force: true })
  // cp's filter is called as filter(source, destination): the source root has to
  // be bound explicitly, or the destination becomes the "relative" base and every
  // entry looks like it escapes the package. A destination inside the source is
  // also copied by hand because cp rejects that shape before consulting a filter.
  if (isInside(resolved.dir, mirror)) {
    await copyTree(resolved.dir, mirror)
  } else {
    await cp(resolved.dir, mirror, { recursive: true, filter: (source) => keepCopy(source, resolved.dir) })
  }

  // A bridged package that cannot reach its own published dependencies is not
  // usable: its first real call dies on an inert stub. Installing them is the
  // default; installDeps: false is an explicit offline escape hatch.
  const deps = (options && options.installDeps === false)
    ? { status: 'skipped', reason: 'installDeps:false' }
    : await installDependencies(mirror, log)

  const allFiles = await walk(mirror, 7)
  const sources = allFiles.filter(f => /\.(ts|mts|js|mjs|cjs)$/.test(f))
  const specs = await scanImports(sources)

  const provide = {}
  for (const s of specs.keys()) {
    const [pkg] = splitSpecifier(s)
    if (PROVIDED[s]) provide[s] = PROVIDED[s]
    else if (PROVIDED[pkg] && pkg === s) provide[pkg] = PROVIDED[pkg]
  }
  const stubPackages = await makeStubs(mirror, specs, { provide, prelude: PRELUDE })

  const build = await compileTypeScript(mirror, sources, log)
  const compiled = build.emitted || build
  const compileFailures = build.failures || []

  let captured
  const skillDirs = []
  if (host === 'dsh') {
    const entry = await dshEntry(mirror, info.pkg)
    if (entry) {
      captured = await captureDsh(redirect(entry, mirror, compiled), info.name, configFor(info.pkg))
    } else {
      captured = { capabilities: [], events: [], unsupported: [], errors: ['no DSH entry module found in package'] }
    }
  } else {
    const entries = await piEntries(mirror, info.pkg)
    // A compiled .ts and its emitted .mjs can both be discovered; loading the
    // same extension twice would register every capability twice.
    const files = [...new Set(entries.extensions.map(f => redirect(f, mirror, compiled)))]
    skillDirs.push(...entries.skills)
    captured = await capturePi(files, info.name)
  }

  if (compileFailures.length) captured.errors = (captured.errors || []).concat(compileFailures.map(f => 'uncompiled ' + f))
  captured.dependencies = deps
  if (deps.status === 'failed' || deps.status === 'partial') {
    captured.degraded = 'dependencies ' + deps.status + ' (' + deps.count + ' declared): ' + deps.reason
      + ' - tools that import them will fail at call time'
  }
  captured.info = info
  captured.host = host
  captured.mirror = mirror
  captured.compiled = compiled
  captured.stubPackages = stubPackages
  captured.skillDirs = [...new Set((captured.skillDirs || []).concat(skillDirs))]
  return captured
}

/** True when child sits inside parent. */
function isInside (parent, child) {
  const a = path.resolve(parent).replace(/\\/g, '/')
  const b = path.resolve(child).replace(/\\/g, '/')
  return b === a || b.startsWith(a + '/')
}

/**
 * True when the path, relative to the package root being copied, is something
 * that should not travel into a mirror. Absolute paths are never tested: a
 * package can legitimately live under a directory whose name looks excluded.
 */
function keepCopy (source, root) {
  const rel = path.relative(String(root), String(source)).replace(/\\/g, '/')
  // cp asks about the root itself first; rejecting it skips the whole tree.
  if (rel === '') return true
  if (rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../')) return false
  return !/(^|[/])(\.git|node_modules|_dsh_pi_bridge|[.][a-z0-9-]*cache)([/]|$)/.test('/' + rel)
}

function slug (s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'package'
}

/** A compiled .ts file is loaded through its emitted .mjs sibling. */
function redirect (file, mirror, compiled) {
  if (!/\.ts$/.test(file) && !/\.mts$/.test(file)) return file
  const rel = path.relative(mirror, file).replace(/\\/g, '/')
  const hit = compiled.find(c => path.relative(mirror, c.source).replace(/\\/g, '/') === rel)
  if (hit) return hit.target
  return path.join(mirror, rel.replace(/\.(ts|mts)$/, '.mjs'))
}

async function compileTypeScript (mirror, sources, log) {
  if (!stripAvailable()) { log('no TypeScript strip support; .ts extensions may fail to load'); return [] }
  const ts = sources.filter(f => /\.(ts|mts)$/.test(f) && !/\.d\.ts$/.test(f))
  if (!ts.length) return []
  const { emitted, failures } = await emitBuild(mirror, mirror, ts)
  if (failures.length) log('TypeScript: ' + failures.length + ' file(s) could not be compiled')
  return { emitted, failures }
}

function configFor (pkg) {
  try { return (pkg && pkg.dsh && pkg.dsh.config) || {} } catch { return {} }
}

export { KNOWN_HOST_PACKAGES, stat }
