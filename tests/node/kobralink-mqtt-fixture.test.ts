// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { connect, type TLSSocket } from 'node:tls'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createSyntheticMqtt } from '../fixtures/kobralink-integration/mqtt.ts'

test('real synthetic MQTT socket handshake and shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-mqtt-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=synthetic.invalid',
    ],
    { stdio: 'ignore' },
  )
  const fixture = createSyntheticMqtt({
    key: readFileSync(join(dir, 'key.pem')),
    cert: readFileSync(join(dir, 'cert.pem')),
  })
  const address = await fixture.start(9883)
  assert.ok(address && typeof address !== 'string')
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const socket: TLSSocket = connect({
        port: address.port,
        host: '127.0.0.1',
        rejectUnauthorized: false,
      })
      await once(socket, 'secureConnect')
      const response: Promise<unknown[]> = once(socket, 'data')
      socket.write(
        Buffer.from([16, 13, 0, 4, 77, 81, 84, 84, 4, 2, 0, 10, 0, 1, 120]),
      )
      assert.deepEqual((await response)[0], Buffer.from([32, 2, 0, 0]))
      const status = new Promise<Buffer>((resolve, reject) => {
        let pending = Buffer.alloc(0)
        const timer = setTimeout(() => {
          socket.off('data', read)
          reject(new Error('publication deadline'))
        }, 2000)
        function read(chunk: Buffer) {
          pending = Buffer.concat([pending, chunk])
          while (pending.length >= 2) {
            let length = 0,
              multiplier = 1,
              offset = 1
            while (true) {
              const digit = pending[offset]
              if (digit === undefined) return
              offset++
              length += (digit & 127) * multiplier
              if (!(digit & 128)) break
              multiplier *= 128
            }
            if (pending.length < offset + length) return
            const header = pending[0]
            const body = pending.subarray(offset, offset + length)
            pending = pending.subarray(offset + length)
            if (header === 0x30) {
              clearTimeout(timer)
              socket.off('data', read)
              resolve(body)
              return
            }
          }
        }
        socket.on('data', read)
      })
      socket.write(Buffer.from([130, 6, 0, 1, 0, 1, 115, 0]))
      assert.ok((await status).includes(Buffer.from('SYNTHETIC')))
      socket.destroy()
      await once(socket, 'close')
    }
  } finally {
    await fixture.stop()
    rmSync(dir, { recursive: true })
  }
})
