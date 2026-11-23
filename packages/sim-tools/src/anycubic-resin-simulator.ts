import { createCipheriv, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'

export async function startPhotonHandshakeSimulator({
  identity,
  credentials,
  fault,
}: {
  identity: Record<string, unknown> & { token: string }
  credentials: Record<string, unknown>
  fault?: 'deny' | 'disconnect' | 'timeout' | 'malformed' | 'bad-ciphertext'
}) {
  let exchanges = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/info' && request.method === 'GET') {
      response.end(JSON.stringify(identity))
      return
    }
    if (url.pathname !== '/ctrl' || request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    exchanges++
    const ts = url.searchParams.get('ts') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''
    const keyDigest = createHash('md5')
      .update(identity.token.slice(0, 16))
      .digest('hex')
    const expected = createHash('md5')
      .update(keyDigest)
      .update(ts)
      .update(nonce)
      .digest('hex')
    if (
      fault === 'deny' ||
      !/^\d{13}$/.test(ts) ||
      !/^[a-f0-9]{16}$/.test(nonce) ||
      !url.searchParams.get('did') ||
      url.searchParams.get('sign') !== expected
    ) {
      response.end(JSON.stringify({ code: 19002 }))
      return
    }
    if (fault === 'timeout') return
    if (fault === 'disconnect') {
      request.socket.destroy()
      return
    }
    if (fault === 'malformed') {
      response.end('{')
      return
    }
    const iv = 'fixture-only-iv!'
    const cipher = createCipheriv('aes-128-cbc', identity.token.slice(16), iv)
    cipher.setAutoPadding(false)
    const plain = Buffer.from(JSON.stringify(credentials))
    const padded = Buffer.concat([
      plain,
      Buffer.alloc((16 - (plain.length % 16)) % 16),
    ])
    const info = Buffer.concat([
      cipher.update(padded),
      cipher.final(),
    ]).toString('base64')
    response.end(
      JSON.stringify({
        code: 200,
        data: { info: fault === 'bad-ciphertext' ? 'AAAA' : info, token: iv },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing loopback address')
  return {
    host: address.address,
    port: address.port,
    exchanges: () => exchanges,
    async close() {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    },
  }
}
