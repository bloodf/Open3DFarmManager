// v2 command path (#609). v1 passed a caller-built context to one function;
// v2 splits capability admission (an opaque handle), signature verification
// and the durable journal. Each case maps to the component that enforces it.
import { afterEach, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  claimCommand,
  closeCommandJournal,
  finishCommand,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { decodeCommandV2 } from '../../packages/farm-protocol/src/command-v2.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
  rejected,
  type V2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

const open: V2Dispatch[] = []
afterEach(() => {
  for (const harness of open.splice(0)) harness.close()
})
async function fixture(options: Parameters<typeof openV2Dispatch>[1] = {}) {
  const authority = await createV2Authority(await nodeSigner())
  const harness = await openV2Dispatch(authority, options)
  open.push(harness)
  return { authority, harness }
}
const reasons = new Set([
  'unsupported-action',
  'invalid-command',
  'invalid-authority',
  'scope',
  'signature',
  'expired',
  'state',
  'busy',
  'replay',
  'storage',
  'revoked',
  'closed',
  'aborted',
  'deadline',
])

// v1: incomplete CommandContext. v2: the authority is an opaque admitted
// handle, so forged, missing or revoked handles stand in for invalid context.
test('incomplete or forged authority returns denial without throwing or claiming', async () => {
  const { authority, harness } = await fixture()
  const wire = await authority.sign()
  for (const invalid of [
    null,
    undefined,
    {},
    { capability_id: authority.ids.capability_id },
    Object.create(Object.getPrototypeOf(harness.handle)),
  ])
    expect(
      await harness.dispatcher.dispatch({
        wire,
        capability: invalid,
        printerBinding: harness.printerBinding,
      }),
    ).toEqual(rejected('invalid-authority'))
  for (const printerBinding of [null, {}, { assignment_id: randomUUID() }])
    expect(
      await harness.dispatcher.dispatch({
        wire,
        capability: harness.handle,
        printerBinding: printerBinding as never,
      }),
    ).toEqual(rejected('scope'))
  harness.revoke()
  expect(await harness.dispatch(wire)).toEqual(rejected('invalid-authority'))
  expect(harness.claims()).toBe(0)
  expect(harness.writes()).toBe(0)
})

test('unexpected storage failures never escape as protocol reasons', async () => {
  const marker = 'INTERNAL_PRIVATE_MARKER'
  for (const gate of [
    () => true,
    () => {
      throw new Error(marker)
    },
    () => marker as unknown as boolean,
  ]) {
    const { authority, harness } = await fixture({ storageDegraded: gate })
    const result = await harness.dispatch(await authority.sign())
    expect(result).toEqual(rejected('storage'))
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(harness.claims()).toBe(0)
  }
  const { authority, harness } = await fixture()
  harness.closeJournal()
  const result = await harness.dispatch(await authority.sign())
  expect(result).toEqual(rejected('storage'))
  expect(reasons.has((result as { reason: string }).reason)).toBe(true)
})

test('all journal denials stay denials and add no claim', async () => {
  // replay
  {
    const { authority, harness } = await fixture()
    const wire = await authority.sign()
    expect((await harness.dispatch(wire)).kind).toBe('applied')
    expect(await harness.dispatch(wire)).toEqual(rejected('replay'))
    expect(harness.claims()).toBe(1)
  }
  // capacity
  {
    const { authority, harness } = await fixture({ journalCapacity: 1 })
    expect(
      (await harness.dispatch(await authority.sign({}, harness.now()))).kind,
    ).toBe('applied')
    expect(
      await harness.dispatch(await authority.sign({}, harness.now())),
    ).toEqual(rejected('storage'))
    expect(harness.claims()).toBe(1)
  }
  // clock-regressed
  {
    const { authority, harness } = await fixture()
    harness.advance(100)
    expect(
      (await harness.dispatch(await authority.sign({}, harness.now()))).kind,
    ).toBe('applied')
    harness.setJournalWall(harness.now() - 50)
    expect(
      await harness.dispatch(await authority.sign({}, harness.now())),
    ).toEqual(rejected('storage'))
    expect(harness.claims()).toBe(1)
  }
  // rate-limited: ten accepted commands per printer per minute
  {
    const { authority, harness } = await fixture()
    for (let i = 0; i < 10; i++)
      expect(
        (await harness.dispatch(await authority.sign({}, harness.now()))).kind,
      ).toBe('applied')
    expect(
      await harness.dispatch(await authority.sign({}, harness.now())),
    ).toEqual(rejected('storage'))
    expect(harness.claims()).toBe(10)
  }
})

test('malformed command frames do not reach the journal', async () => {
  const { authority, harness } = await fixture()
  const wire = await authority.sign()
  for (const frame of [
    'null',
    '[]',
    '{',
    ' '.repeat(8193),
    wire.replace('"v":2', '"v":2,"v":2'),
    wire.replace('"pause"', '"arbitrary-gcode"'),
    42,
    undefined,
  ])
    expect(await harness.dispatch(frame)).toEqual(rejected('invalid-command'))
  expect(harness.claims()).toBe(0)
  expect(harness.writes()).toBe(0)
})

// The journal is the v2 replay store: each documented denial is returned as
// itself and leaves exactly the rows that existed before the attempt.
test('journal claims return each documented denial as itself', async () => {
  const authority = await createV2Authority(await nodeSigner())
  const directory = mkdtempSync(join(tmpdir(), 'open3d-journal-denials-'))
  let wall = 1000
  const journal = openCommandJournal({
    directory,
    clock: () => wall,
    capacity: 12,
  })
  const claim = async (
    overrides: Parameters<typeof authority.command>[0] = {},
  ) =>
    claimCommand(journal, {
      command: decodeCommandV2(await authority.sign(overrides, wall)),
      printerKey: authority.printerKey,
      wireSha256: 'a'.repeat(64),
    })
  try {
    const first = decodeCommandV2(await authority.sign({}, wall))
    const accepted = claimCommand(journal, {
      command: first,
      printerKey: authority.printerKey,
      wireSha256: 'a'.repeat(64),
    })
    expect(accepted.ok).toBe(true)
    expect(
      claimCommand(journal, {
        command: first,
        printerKey: authority.printerKey,
        wireSha256: 'a'.repeat(64),
      }),
    ).toEqual({ ok: false, reason: 'replay' })
    // The first claim is still active on the assignment.
    expect(await claim()).toEqual({ ok: false, reason: 'assignment-busy' })
    // Settled claims no longer exclude, but count toward the per-printer
    // rate limit of ten a minute.
    if (accepted.ok)
      expect(
        finishCommand(journal, accepted.receipt, 'not-sent', 'guard-denied'),
      ).toBe(true)
    for (let i = 1; i < 10; i++) {
      wall += 1
      const next = await claim()
      expect(next.ok).toBe(true)
      if (next.ok)
        expect(
          finishCommand(journal, next.receipt, 'not-sent', 'guard-denied'),
        ).toBe(true)
    }
    wall += 1
    expect(await claim()).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
    wall -= 5
    expect(await claim({ assignment_id: randomUUID() })).toEqual({
      ok: false,
      reason: 'clock-regressed',
    })
    const rows = () => {
      const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'), {
        readOnly: true,
      })
      try {
        return db.prepare('SELECT count(*) AS n FROM pause_commands').get()?.n
      } finally {
        db.close()
      }
    }
    expect(rows()).toBe(10)
    closeCommandJournal(journal)
    const full = openCommandJournal({
      directory,
      clock: () => wall,
      capacity: 10,
    })
    try {
      wall += 10
      expect(
        claimCommand(full, {
          command: decodeCommandV2(
            await authority.sign(
              {
                action: 'emergency_stop',
                purpose: 'printer-control',
                assignment_id: randomUUID(),
              },
              wall,
            ),
          ),
          printerKey: 'printer-2',
          wireSha256: 'a'.repeat(64),
        }),
      ).toEqual({ ok: false, reason: 'capacity' })
      expect(rows()).toBe(10)
    } finally {
      closeCommandJournal(full)
    }
  } finally {
    try {
      closeCommandJournal(journal)
    } catch {
      /* closed above */
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
