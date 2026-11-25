import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { provisionSdcpPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'

import { readCommandOutcome } from '../../packages/connector/src/control/command-journal.ts'
import {
  decodePauseChannelFrame,
  encodePauseChannelFrame,
} from '../../packages/farm-protocol/src/pause-channel.ts'
import { extendedControlStatusText } from '../../apps/farm/app/utils/farm-control.ts'
import { api, browser, RESIN, QUALIFIED } from '../helpers/elegoo-safety.ts'

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

test('browser delivers the pt-BR reason for an unvalidated resin start', async (t) => {
  const world = await browser(t, RESIN, QUALIFIED)
  const result = await world.run('start_print', { file: 'part.ctb' })
  assert.equal(result.kind, 'not-sent')
  assert.equal(result.reason, 'invalid-command')
  assert.match(result.message ?? '', /versão validada do arquivo na biblioteca/)
  const frame = decodePauseChannelFrame(
    encodePauseChannelFrame({
      v: 1,
      t: 'control.result',
      command_id: result.cmdId,
      transport_id: randomUUID(),
      seq: 0,
      outcome: result.kind,
      message: result.message,
    }),
  )
  assert.equal(frame.t, 'control.result')
  assert.ok(frame.message)
  assert.match(
    extendedControlStatusText(
      {
        kind: 'settled',
        outcome: frame.outcome,
        message: frame.message,
      },
      0,
    ),
    /versão validada do arquivo na biblioteca/,
  )
  assert.deepEqual(world.sent(), [])
})

test('API delivers the pt-BR refusal message alongside the diagnostic detail', async (t) => {
  const world = await api(t, RESIN, QUALIFIED)
  await world.refused(
    { kind: 'library', name: 'part.ctb' },
    'unsupported',
    'invalid-command',
  )
  assert.equal(world.reports[0]?.detail, 'invalid-command')
  assert.match(
    world.reports[0]?.message ?? '',
    /versão validada do arquivo na biblioteca/,
  )
})

test('a qualified pair can start a validated library resin artifact', async (t) => {
  const world = await api(t, RESIN, QUALIFIED)
  const { result, status } = await world.send({
    kind: 'resin',
    name: 'part.ctb',
  })
  assert.deepEqual(result, { kind: 'completed' })
  assert.equal(status, 'applied')
  assert.equal(world.validated(), 1)
  assert.deepEqual(world.sent(), [128])
})

test('validated resin replay still requires a qualified firmware pair', async (t) => {
  const world = await api(t, RESIN, [
    { model: RESIN, firmwareVersion: 'V9.9.9' },
  ])
  await world.refused(
    { kind: 'resin', name: 'part.ctb' },
    'unsupported',
    'action not supported by this printer',
  )
  assert.equal(world.validated(), 0)
  assert.match(
    world.reports[0]?.message ?? '',
    /Saturn 4 Ultra com firmware V1\.0\.0/,
  )
})

for (const fault of [{ ack: 1 }, { ignore: true }]) {
  test(`SDCP post-write fault is durably unknown and never resent (${JSON.stringify(fault)})`, async (t) => {
    const world = await browser(t, 'Centauri Carbon', QUALIFIED)
    world.machine.fault = fault
    const result = await world.run('start_print', { file: 'part.gcode' })
    assert.equal(result.kind, 'outcome-unknown')
    assert.equal(
      readCommandOutcome(world.journal, result.cmdId)?.status,
      'outcome-unknown',
    )
    const another = await world.run('start_print', { file: 'part.gcode' })
    assert.equal(another.reason, 'busy')
    assert.deepEqual(world.sent(), [128])
  })
}
