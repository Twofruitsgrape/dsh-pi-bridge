/**
 * TypeScript to ESM JavaScript, for the DSH side.
 *
 * pi extensions are usually .ts and pi loads them with jiti. DSH loads plain
 * ESM. The DSH runtime is Electron 44 / Node 24, where node:module exposes
 * stripTypeScriptTypes, so the conversion needs no dependency and no network.
 * When that is missing we try a resolvable @swc/core or typescript, and if
 * neither exists we refuse with the offending file named: a bridged extension
 * that cannot load has to say why.
 *
 * Relative .ts specifiers in the emitted code are rewritten to .mjs so the
 * mirrored build tree resolves under plain Node ESM.
 *
 * @module src/transpile.js
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require_ = createRequire(import.meta.url)

export function stripAvailable () {
  try { return typeof require_('node:module').stripTypeScriptTypes === 'function' } catch { return false }
}

/** @param {string} source @param {string} filePath @returns {string} */
function strip (source, filePath) {
  return require_('node:module').stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: filePath })
}

/**
 * Compile one TypeScript file to ESM text.
 * @returns {Promise<{code:string, compiler:string}>}
 */
export async function compileTs (filePath) {
  const source = await readFile(filePath, 'utf8')
  if (stripAvailable()) return { code: strip(source, filePath), compiler: 'node:module' }
  try {
    const swc = require_('@swc/core')
    const out = await swc.transform(source, {
      filename: filePath,
      jsc: { parser: { syntax: 'typescript', tsx: false }, target: 'es2022' },
      module: { type: 'es6' },
    })
    return { code: String(out.code), compiler: '@swc/core' }
  } catch { /* fall through */ }
  try {
    const ts = require_('typescript')
    const out = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: filePath,
    })
    return { code: String(out.outputText), compiler: 'typescript' }
  } catch {
    throw new Error('cannot compile TypeScript (no stripTypeScriptTypes, @swc/core or typescript): ' + filePath)
  }
}

const REL_TS = /(from\s*|import\s*\(\s*)(['"])(\.\.?\/[^'"]*?)\.ts\2/g

/** Rewrite relative "./x.ts" specifiers to "./x.mjs". */
export function rewriteTsSpecifiers (code) {
  return code.replace(REL_TS, (all, head, quote, spec) => head + quote + spec + '.mjs' + quote)
}

/**
 * Build a mirrored ESM tree for every TypeScript file under srcDir.
 * @param {string} srcDir package root
 * @param {string} buildDir output root
 * @param {string[]} files absolute .ts paths
 * @returns {Promise<Array<{source:string,target:string,compiler:string}>>}
 */
export async function emitBuild (srcDir, buildDir, files) {
  const emitted = []
  const failures = []
  for (const file of files) {
    if (!/\.ts$/.test(file)) continue
    const rel = path.relative(srcDir, file).replace(/\\/g, '/')
    const target = path.join(buildDir, rel.replace(/\.ts$/, '.mjs'))
    try {
      const { code, compiler } = await compileTs(file)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, rewriteTsSpecifiers(code), 'utf8')
      emitted.push({ source: file, target, compiler })
    } catch (e) {
      // One file the strip pass cannot handle (a parameter property, an enum)
      // must not lose the whole package: the rest still loads and the report
      // names what was skipped.
      failures.push(rel + ': ' + (e && e.message ? String(e.message).split('\n')[0].slice(0, 140) : String(e)))
    }
  }
  return { emitted, failures }
}
