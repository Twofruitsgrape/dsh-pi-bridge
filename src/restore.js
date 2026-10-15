/**
 * Bridge restore: replay recorded bridges when a host process starts.
 *
 * The install tools register capabilities into the running process. On their
 * own that lasts one session, which is not what "installed a plugin" means. The
 * registry written by both halves records each source spec, so a fresh process
 * can re-run the pipeline from the local cache and put the tools and commands
 * back before anyone asks for them.
 *
 * Nothing here reaches the network: a bridge whose cache was pruned reports
 * itself as unavailable and is reinstalled on the next explicit use. The same
 * spec resolves from the bridge cache on a hit. Every entry is restored under
 * its own try/catch, because one broken package must not stop the host from
 * loading the plugin, and duplicate names are reported rather than thrown.
 *
 * @module src/restore.js
 */
import { loadForeign } from './load.js'

/**
 * @param {any} ctx DSH scope
 * @param {any} state registry read from ~/.dsh-pi-bridge/bridges.json
 * @param {{log?:(m:string)=>void}} [options]
 * @returns {Promise<{restored:string[],failed:string[]}>}
 */
export async function restoreIntoDsh (ctx, state, options) {
  const log = (options && options.log) || (() => {})
  const restored = []
  const failed = []
  const { replayIntoDsh } = await import('./replay-dsh.js')
  for (const [spec, entry] of Object.entries((state && state.bridges) || {})) {
    if (entry.host !== 'pi') continue
    try {
      const captured = await loadForeign(spec, { host: 'pi', log, cacheOnly: true })
      const report = await replayIntoDsh(ctx, captured, { prefix: entry.prefix })
      if (report.skipped.length) log('restore ' + spec + ': ' + report.skipped.join('; '))
      if (report.tools.length || report.commands.length || report.skills.length) restored.push(spec)
      else failed.push(spec + ': nothing to restore')
    } catch (e) {
      failed.push(spec + ': ' + (e && e.message ? String(e.message).slice(0, 160) : String(e)))
    }
  }
  return { restored, failed }
}

/**
 * @param {any} pi pi ExtensionAPI
 * @param {any} state registry
 * @param {{log?:(m:string)=>void}} [options]
 * @returns {Promise<{restored:string[],failed:string[]}>}
 */
export async function restoreIntoPi (pi, state, options) {
  const log = (options && options.log) || (() => {})
  const restored = []
  const failed = []
  const { replayIntoPi } = await import('./replay-pi.js')
  for (const [spec, entry] of Object.entries((state && state.bridges) || {})) {
    if (entry.host !== 'dsh') continue
    try {
      const captured = await loadForeign(spec, { host: 'dsh', log, cacheOnly: true })
      const report = replayIntoPi(pi, captured, { prefix: entry.prefix })
      if (report.skipped.length) log('restore ' + spec + ': ' + report.skipped.join('; '))
      if (report.tools.length || report.commands.length || report.skills.length) restored.push(spec)
      else failed.push(spec + ': nothing to restore')
    } catch (e) {
      failed.push(spec + ': ' + (e && e.message ? String(e.message).slice(0, 160) : String(e)))
    }
  }
  return { restored, failed }
}
