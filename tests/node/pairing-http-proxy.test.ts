import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pairingHttpProxy } from '../helpers/pairing-http-proxy.ts'

test('fixture proxy drops one complete claim response and forwards the next', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pairing-proxy-test-'))
  const upstream = createServer((req, res) => {
    assert.equal(req.headers['x-fixture-drop'], undefined)
    res.end('committed')
  })
  let proxy: ReturnType<typeof pairingHttpProxy> | undefined
  try {
    const certPath = join(dir, 'cert.pem'),
      keyPath = join(dir, 'key.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore', timeout: 10_000 },
    )
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const upstreamAddress = upstream.address()
    if (!upstreamAddress || typeof upstreamAddress === 'string')
      throw new Error('upstream unavailable')
    const cert = await readFile(certPath)
    proxy = pairingHttpProxy({
      key: await readFile(keyPath),
      cert,
      upstreamPort: () => upstreamAddress.port,
      dropControl: 'control',
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const address = proxy.address()
    if (!address || typeof address === 'string')
      throw new Error('proxy unavailable')
    const call = () =>
      new Promise<string>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/connector-pairing/claim',
            method: 'POST',
            headers: { 'x-fixture-drop': 'control' },
            ca: cert,
            timeout: 5000,
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => (body += chunk))
            res.on('end', () => resolve(body))
            res.on('error', reject)
          },
        )
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', reject)
        req.end('{}')
      })
    await assert.rejects(
      call(),
      (error: Error & { code?: string }) => error.code === 'ECONNRESET',
    )
    assert.equal(await call(), 'committed')
  } finally {
    if (proxy?.listening)
      await new Promise<void>((resolve, reject) =>
        proxy!.close((error) => (error ? reject(error) : resolve())),
      )
    if (upstream.listening)
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      )
    await rm(dir, { recursive: true, force: true })
  }
})
