import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBambuTransport } from '../../packages/connector/src/bambu/transport.ts'

test('rejects unsafe limits before networking', () => {
  assert.throws(() => createBambuTransport({ host: '127.0.0.1', port: 8883, serial: 'x', credentials: { username: 'bblp', password: 'synthetic' }, limits: { maxFrameBytes: 1048577, connectTimeoutMs: 100, maxInflight: 1, reconnectDelayMs: 10, maxReconnects: 0 }, signal: new AbortController().signal, onReport() {}, onConnection() {} }), /Invalid/)
})

import { createServer } from 'node:tls'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('synthetic TLS peer receives only CONNECT and report SUBSCRIBE', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bambu-transport-'))
  const sockets = new Set<import('node:tls').TLSSocket>()
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key'), '-out', join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
    const cert = readFileSync(join(dir, 'cert'))
    const { X509Certificate } = await import('node:crypto')
    const pin = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex')
    const server = createServer({ key: readFileSync(join(dir, 'key')), cert }, socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('data', data => {
        if (data[0] === 0x10) socket.write(Buffer.from([0x20, 2, 0, 0]))
        else {
          assert.equal(data[0], 0x82)
          assert.ok(data.includes(Buffer.from('device/SYNTHETIC/report')))
          socket.write(Buffer.from([0x90, 3, data[2], data[3], 0]))
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      let connected!: () => void
      const ready = new Promise<void>(resolve => { connected = resolve })
      const transport = createBambuTransport({ host: '127.0.0.1', port: address.port, serial: 'SYNTHETIC', credentials: { username: 'bblp', password: 'synthetic' }, pinSha256: pin, limits: { maxFrameBytes: 4096, connectTimeoutMs: 1000, maxInflight: 1, reconnectDelayMs: 10, maxReconnects: 0 }, signal: new AbortController().signal, onReport() {}, onConnection(state) { if (state === 'connected') connected() } })
      try { await ready } finally { await transport.close() }
      await transport.done
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally { rmSync(dir, { recursive: true }) }
})
