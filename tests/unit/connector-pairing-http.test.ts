import { expect, test } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  pairingRequestBoundary,
  readPairingBody,
} from '../../apps/farm/server/services/connector-pairing.ts'
import {
  loadPairingSigningKey,
  parsePairingConfiguration,
} from '../../apps/farm/server/utils/connector-pairing/runtime.ts'
const origin = 'https://farm.example.invalid'
const request = (headers: Record<string, string> = {}, body = '{}') =>
  new Request(origin + '/api/connector-pairing/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
test('browser mutations require exact configured origin; machine requests reject browser credentials and metadata', () => {
  expect(() =>
    pairingRequestBoundary(request({ origin }), origin, true),
  ).not.toThrow()
  for (const value of ['', 'null', origin + '/', 'https://evil.invalid'])
    expect(() =>
      pairingRequestBoundary(request({ origin: value }), origin, true),
    ).toThrow()
  expect(() => pairingRequestBoundary(request(), origin, true)).toThrow()
  expect(() => pairingRequestBoundary(request(), origin, false)).not.toThrow()
  expect(() =>
    pairingRequestBoundary(
      request({ 'sec-fetch-mode': 'cors' }),
      origin,
      false,
    ),
  ).not.toThrow()
  for (const header of [
    { origin },
    { cookie: 'session=opaque' },
    { 'sec-fetch-site': 'same-origin' },
  ])
    expect(() =>
      pairingRequestBoundary(request(header), origin, false),
    ).toThrow()
  for (const header of [
    { 'content-type': 'text/plain' },
    { 'content-encoding': 'gzip' },
    { 'content-length': '4097' },
  ])
    expect(() =>
      pairingRequestBoundary(request(header), origin, false),
    ).toThrow()
})
test('bounded JSON decoder rejects duplicate, oversized, malformed and deeply nested bodies', async () => {
  expect(
    await readPairingBody(request({}, '{"device_code":"synthetic"}')),
  ).toEqual({ device_code: 'synthetic' })
  for (const body of [
    '{"a":1,"a":2}',
    'x',
    ' '.repeat(4097),
    '{"a":{"b":{"c":{"d":{"e":1}}}}}',
  ])
    await expect(readPairingBody(request({}, body))).rejects.toThrow()
})
test('pairing config remains disabled or unavailable until every private setting is explicit', () => {
  for (const config of [undefined, {}, { enabled: false }])
    expect(() => parsePairingConfiguration(config)).toThrow(
      'Pareamento indisponível',
    )
  expect(() => parsePairingConfiguration({ enabled: true })).toThrow()
  const config = {
    enabled: true,
    origin,
    databaseUrl: 'postgres://synthetic:synthetic@127.0.0.1/synthetic',
    proofDatabaseUrl: 'postgres://synthetic:synthetic@127.0.0.1/synthetic',
    revocationDatabaseUrl: 'postgres://synthetic:synthetic@127.0.0.1/synthetic',
    audience: 'farm:connector',
    issuer: origin,
    signingKeyId: 'synthetic-1',
    signingKeyPath: '/synthetic/key.pem',
    tokenTtlSeconds: '300',
  }
  expect(parsePairingConfiguration(config).tokenTtlSeconds).toBe(300)
  for (const patch of [
    { tokenTtlSeconds: '' },
    { tokenTtlSeconds: 3601 },
    { signingKeyId: '' },
    { origin: 'http://localhost' },
    { signingKeyPath: 'relative.pem' },
    { audience: 'not allowed' },
  ])
    expect(() => parsePairingConfiguration({ ...config, ...patch })).toThrow()
})
test('signing custody accepts only owner-private regular Ed25519 files, rejects symlinks and FIFOs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'farm-pairing-key-'))
  try {
    const path = join(directory, 'key.pem')
    const pair = generateKeyPairSync('ed25519')
    await writeFile(
      path,
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    )
    const key = await loadPairingSigningKey(path)
    expect(key.type).toBe('private')
    expect(key.extractable).toBe(false)
    const link = join(directory, 'link.pem')
    await symlink(path, link)
    await expect(loadPairingSigningKey(link)).rejects.toThrow()
    await chmod(path, 0o644)
    await expect(loadPairingSigningKey(path)).rejects.toThrow()
    const fifo = join(directory, 'fifo.pem')
    execFileSync('mkfifo', [fifo])
    await expect(loadPairingSigningKey(fifo)).rejects.toThrow()
    await chmod(path, 0o600)
    await writeFile(path, 'x'.repeat(8193))
    await expect(loadPairingSigningKey(path)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('body upload deadline cancels an unfinished stream with 408', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'))
    },
    cancel() {
      cancelled = true
    },
  })
  const streamRequest = { method: 'POST', body: stream, duplex: 'half' }
  const pending = new Request(
    origin + '/api/connector-pairing/proof',
    streamRequest,
  )
  try {
    await readPairingBody(pending)
    throw new Error('Expected upload timeout')
  } catch (error) {
    expect(error instanceof Error && 'status' in error && error.status).toBe(
      408,
    )
  }
  expect(cancelled).toBe(true)
}, 7000)
