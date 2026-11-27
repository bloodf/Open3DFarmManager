// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { provisionAnycubicPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { generateKobraXThrowawayTls } from '../../packages/sim-tools/src/mocks/kobra-x-tls.ts'
import { startMqttBroker } from '../../packages/sim-tools/src/mocks/mqtt-broker.ts'

test('Kobra 3 startup does not read firmware when a write pair is supplied', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fix-963b-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const passwordFile = join(directory, 'password.json')
  await writeFile(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })

  // This local TLS broker models the read response without opening a hardware
  // connection. Its synthetic cert and credentials stay within the fixture.
  const tls = generateKobraXThrowawayTls({ dirPrefix: 'fix-963b-tls-' })
  t.after(tls.cleanup)
  const serial = '20024/SYNTHETIC'
  const report = `anycubic/anycubicCloud/v1/printer/public/${serial}/info/report`
  const requests: string[] = []
  let broker: Awaited<ReturnType<typeof startMqttBroker>>
  broker = await startMqttBroker({
    tls,
    auth: { username: 'synthetic', password: 'synthetic' },
    authorizeSubscribe: (topic) => topic.endsWith('/+/report'),
    onPublish(message) {
      requests.push(message.topic)
      broker.control.publish(report, {
        type: 'info',
        action: 'report',
        data: { version: 'sim-kobra-3' },
      })
    },
  })
  t.after(() => broker.close())

  const binding = provisionAnycubicPrinter(
    {
      assignment_id: randomUUID(),
      printer_key: 'printer',
      farm_id: randomUUID(),
      agent_id: randomUUID(),
    },
    {
      printerKey: 'printer',
      host: '127.0.0.1',
      port: broker.ports.mqtt,
      modelId: '20024',
      deviceId: 'SYNTHETIC',
      username: 'synthetic',
      passwordFile,
      pinSha256: tls.serverFingerprintSha256,
    },
  )

  const routes = createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock: { monotonicNow: () => performance.now() },
    observe: () => true,
    // Exercise the startup read boundary even when a local list is supplied.
    anycubicQualifiedWrites: [
      { modelId: '20024', firmwareVersion: 'sim-kobra-3' },
    ],
  })
  t.after(() => routes.closeAttempt(binding))

  await routes.detect(binding)

  assert.deepEqual(requests, [])
})
