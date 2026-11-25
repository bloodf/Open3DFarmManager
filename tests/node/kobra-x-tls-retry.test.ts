// SPDX-License-Identifier: AGPL-3.0-or-later
// TLS 1.3 HelloRetryRequest under the Kobra X client identity hold (review 3).
// Loopback only: a pinned client meets a server that offers the default groups
// or only P-256. OpenSSL 3.5 sends X25519MLKEM768 and X25519 key shares first,
// so a P-256-only server answers with a HelloRetryRequest and the client must
// get its second ClientHello out while the certificate stays held.
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import {
  connect as netConnect,
  createServer as createNetServer,
} from 'node:net'
import { createServer } from 'node:tls'
import test from 'node:test'
import {
  connectAnycubicTls,
  PinMismatch,
} from '../../packages/connector/src/anycubic/tls-trust.ts'
import { generateKobraXThrowawayTls } from '../../packages/sim-tools/src/mocks/kobra-x-tls.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CHANGE_CIPHER_SPEC = 20
const HANDSHAKE = 22
const CLIENT_HELLO = 1

function spkiOf(pem: string | Buffer) {
  return createHash('sha256')
    .update(
      new X509Certificate(pem).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    .digest('hex')
}

/** Splits the client's wire bytes into TLS records. */
function records(all: Buffer) {
  const out: { type: number; handshake?: number; end: number }[] = []
  for (let at = 0; at + 5 <= all.length;) {
    const end = at + 5 + all.readUInt16BE(at + 3)
    const type = all[at]!
    out.push({
      type,
      ...(type === HANDSHAKE ? { handshake: all[at + 5] } : {}),
      end: Math.min(end, all.length),
    })
    at = end
  }
  return out
}

function fixture(t: test.TestContext, ecdhCurve?: string) {
  const material = generateKobraXThrowawayTls({ dirPrefix: 'kx-tls-retry-' })
  t.after(material.cleanup)
  const server = createServer({
    key: material.server.key,
    cert: material.server.cert,
    ca: material.ca.cert,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    ...(ecdhCurve ? { ecdhCurve } : {}),
  })
  const peers: boolean[] = []
  const received: Buffer[] = []
  const wire: Buffer[] = []
  server.on('secureConnection', (socket) => {
    peers.push(!!socket.getPeerCertificate()?.raw)
    socket.on('data', (chunk) => received.push(chunk))
    socket.on('error', () => {})
  })
  server.on('tlsClientError', () => {})
  // A transparent loopback relay records every byte the client sends.
  const relay = createNetServer((client) => {
    const upstream = netConnect({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
    })
    client.on('data', (chunk) => {
      wire.push(chunk)
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => client.write(chunk))
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
    client.on('error', () => {})
    upstream.on('error', () => {})
  })
  const ready = new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      relay.listen(0, '127.0.0.1', () =>
        resolve((relay.address() as { port: number }).port),
      ),
    ),
  )
  t.after(
    () =>
      new Promise<void>((resolve) =>
        relay.close(() => server.close(() => resolve())),
      ),
  )

  async function attempt(pin: string) {
    peers.length = 0
    received.length = 0
    wire.length = 0
    const port = await ready
    const socket = connectAnycubicTls(
      {
        host: '127.0.0.1',
        port,
        cert: material.client.cert,
        key: material.client.key,
        minVersion: 'TLSv1.3',
      },
      pin,
      { holdClientIdentity: true },
    )
    let error: Error | undefined
    socket.on('error', (failure) => (error ??= failure))
    const settled = await Promise.race([
      new Promise<'settled'>((resolve) => {
        socket.once('error', () => resolve('settled'))
        socket.once('secureConnect', () => {
          if (!socket.destroyed) socket.write('application-data')
          resolve('settled')
        })
      }),
      sleep(5000).then(() => 'stalled' as const),
    ])
    await sleep(150)
    socket.destroy()
    const all = Buffer.concat(wire)
    const list = records(all)
    const hellos = list.filter(
      (r) => r.type === HANDSHAKE && r.handshake === CLIENT_HELLO,
    )
    return {
      settled,
      error,
      clientHellos: hellos.length,
      clientCertificateReached: peers.some(Boolean),
      applicationData: Buffer.concat(received).toString(),
      /** Records other than ClientHello / compatibility CCS the client sent. */
      otherRecords: list.filter(
        (r) =>
          r.type !== CHANGE_CIPHER_SPEC &&
          !(r.type === HANDSHAKE && r.handshake === CLIENT_HELLO),
      ).length,
      bytesAfterLastClientHello: hellos.length
        ? all.length - hellos.at(-1)!.end
        : all.length,
    }
  }

  return {
    attempt,
    right: spkiOf(material.server.cert),
    wrong: spkiOf(material.client.cert),
  }
}

test('default groups: pinned handshake completes without a HelloRetryRequest', async (t) => {
  const f = fixture(t)
  const r = await f.attempt(f.right)
  assert.equal(r.settled, 'settled')
  assert.equal(r.error, undefined)
  assert.equal(r.clientHellos, 1)
  assert.equal(r.clientCertificateReached, true)
  assert.equal(r.applicationData, 'application-data')
})

test('P-256-only peer: HelloRetryRequest no longer stalls the pinned handshake', async (t) => {
  const f = fixture(t, 'P-256')
  const r = await f.attempt(f.right)
  assert.equal(
    r.settled,
    'settled',
    'handshake stalled after HelloRetryRequest',
  )
  assert.equal(r.error, undefined)
  assert.equal(r.clientHellos, 2, 'the server sent a HelloRetryRequest')
  assert.equal(r.clientCertificateReached, true)
  assert.equal(r.applicationData, 'application-data')
})

test('default groups: a wrong pin gets only the ClientHello', async (t) => {
  const f = fixture(t)
  const r = await f.attempt(f.wrong)
  assert.ok(r.error instanceof PinMismatch)
  assert.equal(r.clientHellos, 1)
  assert.equal(r.clientCertificateReached, false)
  assert.equal(r.applicationData, '')
  assert.equal(r.otherRecords, 0)
  assert.equal(r.bytesAfterLastClientHello, 0)
})

test('P-256-only peer: a wrong pin gets only the two ClientHellos', async (t) => {
  const f = fixture(t, 'P-256')
  const r = await f.attempt(f.wrong)
  assert.ok(r.error instanceof PinMismatch)
  assert.equal(r.clientHellos, 2)
  assert.equal(r.clientCertificateReached, false)
  assert.equal(r.applicationData, '')
  assert.equal(r.otherRecords, 0, 'no encrypted flight left the client')
  assert.equal(r.bytesAfterLastClientHello, 0)
})
