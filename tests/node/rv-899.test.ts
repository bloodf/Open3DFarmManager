import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { provisionSdcpPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'

test('failed SDCP firmware detection retains lifecycle controls without start', async () => {
  const binding = provisionSdcpPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'elegoo',
    },
    {
      printerKey: 'elegoo',
      host: '127.0.0.1',
      mainboardId: 'board01',
      model: 'Centauri Carbon',
    },
  )
  const router = createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock: { monotonicNow: () => performance.now() },
    observe: () => true,
    sdcpQualifiedStarts: [
      { model: 'Centauri Carbon', firmwareVersion: 'V1.0.0' },
    ],
  })
  const abort = new AbortController()
  abort.abort()
  assert.deepEqual(await router.detect(binding, abort.signal), [
    'pause',
    'resume',
    'cancel',
  ])
})
