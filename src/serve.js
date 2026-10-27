/**
 * A loopback endpoint inside a live DSH process, so another host (pi) can use
 * DSH plugins without translating them.
 *
 * This is the DSH counterpart of the pi bootstrap: plugins stay inside their own
 * host, where ctx.tools, ctx.llm and the skill registry are genuine, and the
 * remote side only forwards. Off unless DSH_PI_BRIDGE_DSH_SERVE is set, so a
 * normal DSH boot never opens a port. Bound to 127.0.0.1, and every call answers
 * as data rather than throwing, so a bad plugin cannot take the host down.
 *
 * @module src/serve.js
 */
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFingerprint } from './build-id.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const REGEX_PORT = /^127\.0\.0\.1$|::1$/

/**
 * @param {number} port
 * @param {{load:(source:string)=>Promise<any>, call:(name:string,args:any)=>Promise<any>, list:()=>any[]}} handlers
 * @returns {{close:()=>void, port:number}|null}
 */
/** Digest of the bridge modules this process loaded; see src/build-id.js. */
const BRIDGE_VERSION = buildFingerprint(path.resolve(HERE, '..'))

export function startDshServer (port, handlers) {
  if (!port || !Number.isFinite(port)) return null
  const held = new Map()

  /*
   * Exit when the process that started this host is gone.
   *
   * A DSH started to serve one pi is worthless without that pi, and leaving it
   * running would hold a port and a profile for nobody. Relying on stdin closing
   * was measured and did not work: the SDK runtime keeps running after its parent
   * exits, so the orphan check has to be explicit. `kill(pid, 0)` asks whether the
   * pid exists without signalling it; EPERM means it exists but belongs to
   * someone else, which still counts as alive.
   */
  const parentPid = Number(process.env.DSH_PI_BRIDGE_PARENT_PID || 0)
  if (Number.isFinite(parentPid) && parentPid > 0) {
    const timer = setInterval(() => {
      try { process.kill(parentPid, 0) } catch (e) {
        if (e && e.code !== 'EPERM') process.exit(0)
      }
    }, 2000)
    timer.unref()
  }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const url = (req.url || '/').split('?')[0]
      const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      try {
        if (url === '/health') {
          // The fingerprint of the bridge code this session is running. A DSH
          // session outlives edits to the installed copy just as the pi daemon
          // does, and measuring through one that predates the change silently
          // reports the previous build's behaviour - twice now, once on each side.
          //
          // `meta` lets the host add facts about how it is wired - which call
          // path forwarding uses, for instance - so a caller can assert the
          // faithful path instead of only that something answered.
          const extra = typeof handlers.meta === 'function' ? handlers.meta() : {}
          return send({ ok: true, pid: process.pid, serve: true, tools: handlers.list().length, bridgeVersion: BRIDGE_VERSION, ...extra })
        }
        if (url === '/tools') return send({ ok: true, tools: handlers.list() })
        const body = raw ? JSON.parse(raw) : {}
        if (url === '/load') {
          const r = await handlers.load(body.source)
          for (const t of r.tools || []) held.set(t.name, r)
          return send({ ok: !r.error, ...r, callable: undefined })
        }
        if (url === '/call') {
          const r = await handlers.call(body.name, body.args || {})
          return send(r)
        }
        return send({ ok: false, error: 'not found: ' + url })
      } catch (e) {
        return send({ ok: false, error: 'dsh serve: ' + String((e && e.message) || e).slice(0, 300) })
      }
    })
  })
  server.on('error', () => { /* port busy: the caller reports it */ })
  server.listen(port, '127.0.0.1')
  void held
  return { close: () => server.close(), port }
}

/** True for the loopback addresses this endpoint accepts. */
export function isLoopback (host) {
  return REGEX_PORT.test(String(host || ''))
}
