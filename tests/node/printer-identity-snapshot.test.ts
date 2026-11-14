import test from 'node:test'
import assert from 'node:assert/strict'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { randomUUID } from 'node:crypto'

const printer = {
  printerKey: 'fixture',
  state: 'idle' as const,
  progress: 0,
  observedAt: 0,
}

test('identity is optional and absent fields remain absent', () => {
  assert.deepEqual(PrinterState.parse(printer), printer)
  for (const identity of [
    { firmware: 'Klipper v0.13' },
    { vendor: 'Bambu Lab', model: 'X1C', firmware: '01.08' },
    { vendor: 'Creality', model: 'K2', firmware: '1.0' },
  ]) {
    assert.deepEqual(
      PrinterState.parse({ ...printer, identity }).identity,
      identity,
    )
  }
})

test('identity rejects unbounded values and credentials', () => {
  for (const identity of [
    { model: '' },
    { firmware: 'x'.repeat(1025) },
    { vendor: 'x'.repeat(256) },
    { model: 'K2', accessCode: 'synthetic' },
  ]) {
    assert.equal(
      PrinterState.safeParse({ ...printer, identity }).success,
      false,
    )
  }
})

test('field-stamped identity requires observation provenance', () => {
  const source = createFarmSnapshotSource({
    assignmentRefs: [
      {
        assignmentId: randomUUID(),
        agentId: randomUUID(),
        printerKey: 'fixture',
      },
    ],
    nowMono: () => 100,
  })
  try {
    assert.throws(
      () =>
        source.observe({
          printerKey: 'fixture',
          epoch: 1,
          printer: { ...printer, identity: { model: 'X1C' } },
          receivedAtMonoMs: 100,
          fieldObservedAtMonoMs: { bambu: { state: 100, progress: 100 } },
        }),
      /Invalid observation time/,
    )
    source.observe({
      printerKey: 'fixture',
      epoch: 2,
      printer: { ...printer, identity: { model: 'X1C' } },
      receivedAtMonoMs: 100,
      fieldObservedAtMonoMs: {
        bambu: { state: 100, progress: 100, identity: 100 },
      },
    })
  } finally {
    source.close()
  }
})
