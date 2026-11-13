// SPDX-License-Identifier: MIT
// Original synthetic credential responder. No manufacturer keys or actuators.
import { createServer } from 'node:http'
import { createCipheriv, randomBytes } from 'node:crypto'

export function createSyntheticDevice() {
  const token = randomBytes(16).toString('hex')
  const iv = randomBytes(8).toString('hex')
  const credentials = {
    username: 'synthetic-only',
    password: randomBytes(24).toString('hex'),
    deviceId: 'OPENFARM_SYNTHETIC_KOBRA_X_001',
    modeId: '20030',
    modelName: 'Synthetic Kobra X (not firmware qualification)',
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid')
    res.setHeader('content-type', 'application/json')
    res.setHeader('connection', 'close')
    if (req.method === 'GET' && url.pathname === '/info') {
      res.end(JSON.stringify({ token }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/ctrl') {
      // A bounded discovery envelope only; no signature algorithm emulated.
      if (
        !/^\d{13}$/.test(url.searchParams.get('ts') ?? '') ||
        !/^[A-Za-z0-9]{6}$/.test(url.searchParams.get('nonce') ?? '') ||
        !/^[a-f0-9]{32}$/.test(url.searchParams.get('sign') ?? '') ||
        url.searchParams.get('did') !== 'random'
      ) {
        res.writeHead(400).end('{}')
        return
      }
      const cipher = createCipheriv(
        'aes-128-cbc',
        Buffer.from(token.slice(16)),
        Buffer.from(iv),
      )
      const info = Buffer.concat([
        cipher.update(JSON.stringify(credentials)),
        cipher.final(),
      ]).toString('base64')
      res.end(JSON.stringify({ data: { token: iv, info } }))
      return
    }
    res.writeHead(404).end('{}')
  })
  server.maxHeadersCount = 16
  server.headersTimeout = 2000
  server.requestTimeout = 2000
  return { server, credentials }
}
