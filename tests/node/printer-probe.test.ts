import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { createServer as tlsServer } from 'node:tls'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probePrinterHost } from '../../packages/connector/src/discovery/probe.ts'

const host = '127.0.0.1'

test('detects Moonraker and bridge facade using read-only requests', async () => {
  for (const port of [7125, 7126]) {
    const server = httpServer((req, res) => {
      assert.equal(req.method, 'GET')
      assert.equal(req.url, '/server/info')
      res.end(JSON.stringify({ result: { moonraker_version: 'test' } }))
    })
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(port, host, resolve),
    )
    try {
      assert.deepEqual(await probePrinterHost(host, { timeoutMs: 200 }), {
        vendor: 'moonraker',
        host,
        port,
        ...(port === 7126 ? { hint: 'may be a KobraLink bridge' } : {}),
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }
})

test('detects a WebSocket upgrade without sending commands', async () => {
  const server = httpServer()
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(
        req.headers['sec-websocket-key'] +
          '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
      )
      .digest('base64')
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  })
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(9999, host, resolve),
  )
  try {
    assert.deepEqual(await probePrinterHost(host, { timeoutMs: 200 }), {
      vendor: 'creality',
      host,
      port: 9999,
    })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('detects TLS signatures without application data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'printer-probe-'))
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key'),
        '-out',
        join(dir, 'cert'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )
    for (const [port, vendor] of [
      [8883, 'bambu'],
      [9883, 'anycubic'],
    ] as const) {
      let bytes = 0
      const server = tlsServer(
        {
          key: readFileSync(join(dir, 'key')),
          cert: readFileSync(join(dir, 'cert')),
        },
        (socket) => {
          socket.on('data', (data: Buffer) => {
            bytes += data.length
          })
        },
      )
      await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(port, host, resolve),
      )
      try {
        assert.deepEqual(await probePrinterHost(host, { timeoutMs: 300 }), {
          vendor,
          host,
          port,
        })
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
      assert.equal(bytes, 0)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('times out stalled connections and returns no match', async () => {
  const sockets = new Set<import('node:net').Socket>()
  const server = tcpServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(7125, host, resolve),
  )
  try {
    assert.equal(await probePrinterHost(host, { timeoutMs: 50 }), undefined)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  assert.equal(await probePrinterHost(host, { timeoutMs: 50 }), undefined)
  await assert.rejects(probePrinterHost('localhost/path'), /invalid host/)
  await assert.rejects(
    probePrinterHost(host, { timeoutMs: 3001 }),
    /invalid timeout/,
  )
})
