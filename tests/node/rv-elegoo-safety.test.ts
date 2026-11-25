// #893: SDCP start is neither offered nor sent on an unqualified model and
// firmware pair. #894: every SDCP refusal before the write ends as not sent.
// Loopback simulator only: nothing here reaches a physical printer.
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import type { PrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import { buildSdcpCommand } from '../../packages/connector/src/sdcp/commands.ts'
import { openFixedSdcpControl } from '../../packages/connector/src/sdcp/control-driver.ts'
import {
  SDCP_QUALIFIED_STARTS,
  type SdcpQualification,
} from '../../packages/connector/src/sdcp/models.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  api,
  browser,
  printer,
  router,
  CARBON,
  RESIN,
  FIRMWARE,
  QUALIFIED,
  LIFECYCLE,
} from '../helpers/elegoo-safety.ts'

test('the shipped qualification list is empty', () => {
  assert.deepEqual(SDCP_QUALIFIED_STARTS, [])
})

for (const model of [CARBON, RESIN]) {
  test(`${model}: an unqualified pair is not offered a start`, async (t) => {
    const { binding } = await printer(t, model)
    for (const qualified of [
      undefined,
      [{ model, firmwareVersion: 'V9.9.9' }],
      [{ model: 'Mars 5 Ultra', firmwareVersion: FIRMWARE }],
    ]) {
      const routes = router(qualified)
      assert.deepEqual(routes.controls(binding), LIFECYCLE)
      assert.deepEqual(await routes.detect(binding), LIFECYCLE)
    }
    const routes = router(QUALIFIED)
    // Offered only once the printer has named a qualified firmware.
    assert.deepEqual(routes.controls(binding), LIFECYCLE)
    assert.deepEqual(await routes.detect(binding), [
      ...LIFECYCLE,
      'start_print',
    ])
  })
}

async function openDriver(
  binding: PrinterBinding,
  qualified?: SdcpQualification[],
) {
  const control = openFixedSdcpControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish() {},
    signal: new AbortController().signal,
    timeoutMs: 300,
    pollMs: 20,
    qualifiedStarts: qualified,
  })
  await control.prepare()
  return control
}

const refusal =
  (reason: DriverRefusalError['refusal'], message?: RegExp) =>
  (error: unknown) =>
    error instanceof DriverRefusalError &&
    error.refusal === reason &&
    (!message || message.test(error.message))

test('the driver itself refuses an unqualified start with the pair named', async (t) => {
  for (const [model, file] of [
    [CARBON, 'part.gcode'],
    [RESIN, 'part.ctb'],
  ] as const) {
    const world = await printer(t, model)
    for (const qualified of [
      undefined,
      [{ model, firmwareVersion: 'V9.9.9' }],
    ]) {
      const control = await openDriver(world.binding, qualified)
      t.after(() => control.close())
      await assert.rejects(
        control.driver.execute!(
          'start_print',
          { file },
          {
            binding: world.binding,
            signal: new AbortController().signal,
            beforeSend: () => assert.fail('guard reached'),
          },
        ),
        refusal(
          'unsupported-action',
          new RegExp(`not qualified for ${model} firmware ${FIRMWARE}`),
        ),
      )
    }
    assert.deepEqual(world.sent(), [])
  }
})

test('every builder failure is a typed refusal', () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    ['Mars 4 Ultra', 'pause', {}, 'unsupported-action'],
    [RESIN, 'emergency_stop', {}, 'unsupported-action'],
    [RESIN, 'pause', { extra: true }, 'invalid-command'],
    [RESIN, 'start_print', {}, 'invalid-command'],
    [RESIN, 'start_print', { file: 'part.gcode' }, 'invalid-command'],
    [CARBON, 'start_print', { file: '../part.gcode' }, 'invalid-command'],
    [
      CARBON,
      'start_print',
      { file: 'part.gcode', plate: 1 },
      'invalid-command',
    ],
  ]
  for (const [model, action, args, reason] of cases)
    assert.throws(
      () => buildSdcpCommand(model, action as 'pause', args),
      refusal(reason as DriverRefusalError['refusal']),
      `${model} ${action} ${JSON.stringify(args)}`,
    )
})

test('every driver failure before the write guard is a typed refusal', async (t) => {
  const world = await printer(t, CARBON)
  const run = async (
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    before?: () => Promise<void>,
    signal = new AbortController().signal,
  ) => {
    const control = await openDriver(world.binding, QUALIFIED)
    t.after(() => control.close())
    await before?.()
    return control.driver.execute!(action, args, {
      binding: world.binding,
      signal,
      beforeSend: () => assert.fail('guard reached'),
    })
  }
  await assert.rejects(run('set_light', {}), refusal('unsupported-action'))
  await assert.rejects(
    run('start_print', { file: 'part.ctb' }),
    refusal('invalid-command'),
  )
  await assert.rejects(
    run('pause', {}, undefined, AbortSignal.abort()),
    refusal('state'),
  )
  // The idle wait times out.
  await assert.rejects(
    run('start_print', { file: 'part.gcode' }, world.turnBusy),
    (error: DriverRefusalError) =>
      refusal('state')(error) &&
      (error.cause as { code?: string }).code === 'SDCP_CONTROL_TIMEOUT',
  )
  // The printer connection drops before the send.
  await assert.rejects(
    run('pause', {}, async () => {
      await world.close()
      await sleep(60)
    }),
    refusal('state'),
  )
  assert.deepEqual(world.sent(), [])
})

for (const [model, file] of [
  [CARBON, 'part.gcode'],
  [RESIN, 'part.ctb'],
] as const) {
  test(`browser: ${model} refuses a start on an unqualified pair`, async (t) => {
    const world = await browser(t, model, undefined)
    await world.refused('rejected', file, 'unsupported-action')
    assert.deepEqual(world.sent(), [])
    await world.pauses()
  })
}

for (const file of ['part.ctb', 'part.goo']) {
  test(`browser: a qualified resin pair still refuses a bare ${file} start`, async (t) => {
    const world = await browser(t, RESIN, QUALIFIED)
    await world.refused('not-sent', file, 'invalid-command')
    assert.deepEqual(world.sent(), [])
    await world.pauses()
  })
}

test('browser: an invalid command is not sent and blocks nothing', async (t) => {
  const world = await browser(t, RESIN, QUALIFIED)
  await world.refused('not-sent', 'part.gcode', 'invalid-command')
  // The same reason again, not `busy`: the first one left no lock.
  await world.refused('not-sent', 'part.gcode', 'invalid-command')
  await world.pauses()
})

test('browser: an idle-wait timeout is not sent and blocks nothing', async (t) => {
  const world = await browser(t, CARBON, QUALIFIED, true)
  await world.refused('not-sent', 'part.gcode', 'state')
  assert.deepEqual(world.sent(), [])
})

test('API: a start on an unqualified pair is refused before any transfer', async (t) => {
  const world = await api(t, CARBON, undefined)
  await world.refused(
    { kind: 'job', name: 'part.gcode' },
    'unsupported',
    'job delivery is not supported by this printer',
  )
  await world.refused(
    { kind: 'library', name: 'part.gcode' },
    'unsupported',
    'action not supported by this printer',
  )
  assert.equal(world.downloads(), 0)
  assert.equal(world.sim.chunks.length, 0)
})

test('API: a resin file job is refused on a qualified pair', async (t) => {
  const world = await api(t, RESIN, QUALIFIED)
  await world.refused(
    { kind: 'job', name: 'part.ctb' },
    'unsupported',
    'resin-artifact-requires-library-version',
  )
  assert.equal(world.downloads(), 0)
})

test('API: invalid Elegoo commands are not sent and block nothing', async (t) => {
  const world = await api(t, RESIN, QUALIFIED)
  for (const name of ['part.gcode', 'part.ctb', 'part.gcode'])
    await world.refused(
      { kind: 'library', name },
      'unsupported',
      'invalid-command',
    )
})

test('API: a job idle-wait timeout is not sent and blocks nothing', async (t) => {
  const world = await api(t, CARBON, QUALIFIED)
  world.onExecute(world.turnBusy)
  // Twice: the second attempt is not blocked by the first.
  for (let attempt = 0; attempt < 2; attempt++) {
    world.machine.transferring = false
    await world.refused(
      { kind: 'job', name: 'part.gcode' },
      'wrong-state',
      'state',
    )
  }
  world.onExecute(async () => {})
  world.machine.transferring = false
  const { result, status } = await world.send({
    kind: 'job',
    name: 'part.gcode',
  })
  assert.deepEqual(result, { kind: 'completed' })
  assert.equal(status, 'applied')
  assert.deepEqual(world.sent(), [128])
})
