/**
 * Reach a live DSH session from another host, over loopback HTTP.
 *
 * This is the mirror of the pi bootstrap: a DSH plugin is never translated into
 * pi. It is loaded inside the running DSH, where ctx.tools, ctx.llm and the
 * skill registry are genuine, and pi receives one forwarding tool per capability.
 * The DSH half opens the endpoint only when asked (DSH_PI_BRIDGE_DSH_SERVE or a
 * servePort in its bundle config), so an ordinary DSH boot listens on nothing.
 *
 * Nothing here spawns DSH: a headless invocation runs one task and exits, so the
 * process has to be the one the user is already in. Point the client at it:
 *   DSH_PI_BRIDGE_DSH_ENDPOINT   host:port (default 127.0.0.1:43191)
 *
 * @module src/dsh-host-client.js
 */
import http from 'node:http'
import { toToolSchema } from './schema.js'

const HOST = '127.0.0.1'
export function dshEndpoint (env = process.env) {
  const raw = env.DSH_PI_BRIDGE_DSH_ENDPOINT || (HOST + ':43191')
  const idx = raw.lastIndexOf(':')
  const host = idx > 0 ? raw.slice(0, idx) : HOST
  const port = Number(idx > 0 ? raw.slice(idx + 1) : raw)
  if (!Number.isFinite(port) || port <= 0) throw new Error('bad DSH_PI_BRIDGE_DSH_ENDPOINT: ' + raw)
  if (host !== HOST && host !== '::1' && host !== 'localhost') {
    throw new Error('refusing a non-loopback DSH endpoint: ' + raw)
  }
  return { host, port }
}

function request (method, route, body, ms, endpoint) {
  const { host, port } = endpoint || dshEndpoint()
  return new Promise((res, rej) => {
    const req = http.request({
      host, port, path: route, method, agent: false, timeout: ms,
      headers: { 'content-type': 'application/json' },
    }, (r) => {
      let raw = ''
      r.on('data', (c) => { raw += c })
      r.on('end', () => { try { res(JSON.parse(raw)) } catch (e) { rej(new Error('DSH host reply was not JSON: ' + raw.slice(0, 120))) } })
    })
    req.on('timeout', () => req.destroy(new Error('DSH host timed out on ' + route)))
    req.on('error', (e) => rej(new Error('cannot reach the DSH host at ' + host + ':' + port + ' (' + (e.code || e.message) + '); start DSH with DSH_PI_BRIDGE_DSH_SERVE=' + port)))
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

export function dshHostStatus (options) {
  return request('GET', '/health', null, 8000, options && options.endpoint)
}

export function dshHostTools (options) {
  return request('GET', '/tools', null, 15000, options && options.endpoint)
}

/** Ask the live DSH to load a bundle; returns the tools it registered. */
export function dshHostLoad (source, options) {
  return request('POST', '/load', { source }, 120000, options && options.endpoint)
}

/** Invoke a tool that the DSH session holds, and take back its native result. */
export function dshHostCall (name, args, options) {
  return request('POST', '/call', { name, args: args || {} }, (options && options.ms) || 120000, options && options.endpoint)
}

/**
 * Turn one DSH tool's parameter declaration into a JSON Schema pi validates.
 *
 * The DSH side stores a property spec map ({ q: { type:'string', required:true } })
 * or, when it came from the host compiler, an already-compiled schema. Both are
 * accepted by the shared converter in schema.js, which is also what the DSH-to-pi
 * replay path uses - importing it keeps the two directions from drifting.
 */
export function dshParamsToSchema (params) {
  return toToolSchema(params)
}
