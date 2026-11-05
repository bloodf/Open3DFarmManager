import { createServer } from 'node:https'
import { request } from 'node:http'

/** Synthetic loopback proxy: a secret fixture control drops one committed claim response. */
export function pairingHttpProxy(input: {
  key: Buffer
  cert: Buffer
  upstreamPort: () => number
  dropControl: string
}) {
  let dropped = false
  return createServer({ key: input.key, cert: input.cert }, (req, res) => {
    const drop =
      !dropped &&
      req.url === '/api/connector-pairing/claim' &&
      req.headers['x-fixture-drop'] === input.dropControl
    const headers = { ...req.headers }
    delete headers['x-fixture-drop']
    const upstream = request(
      {
        host: '127.0.0.1',
        port: input.upstreamPort(),
        path: req.url,
        method: req.method,
        headers,
      },
      (reply) => {
        if (drop && reply.statusCode === 200) {
          dropped = true
          reply.resume()
          reply.once('end', () => res.destroy())
          return
        }
        res.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
}
