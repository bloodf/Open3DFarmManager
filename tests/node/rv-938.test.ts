// #938: an unconfirmed browser firmware_restart must not leave the printer busy.
// Journal and shipped dispatcher against a fake driver: nothing here contacts a
// printer.
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimCommand,
  closeCommandJournal,
  finishCommand,
  FIRMWARE_RESTART_HOLD_MS,
  markWriteStarted,
  openCommandJournal,
  readCommandOutcome,
  type CommandJournalReason,
} from '../../packages/connector/src/control/command-journal.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

const IDS = {
  farm_id: randomUUID(),
  agent_id: randomUUID(),
  account_id: 'text_account',
  key_id: randomUUID(),
  transport_id: randomUUID(),
  capability_id: randomUUID(),
  assignment_id: randomUUID(),
}
const BUSY = { ok: false, reason: 'assignment-busy' }

function journalFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-938-journal-'))
  let now = 100_000
  const open = () => openCommandJournal({ directory, clock: () => now })
  let journal = open()
  t.after(() => {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  function claim(action: ExtendedControlAction) {
    const cmd_id = randomUUID()
    const result = claimCommand(journal, {
      command: {
        v: 2,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        cmd_id,
        ...IDS,
        action,
        args: {},
        issued_at: now,
        expires_at: now + 5000,
        nonce: randomBytes(16).toString('base64url'),
        sig: 'A'.repeat(86),
      },
      printerKey: 'printer',
      wireSha256: 'a'.repeat(64),
    })
    return { cmd_id, result }
  }
  return {
    claim,
    /** Claims, sends and records an unknown outcome; returns the command id. */
    unknown(
      action: ExtendedControlAction,
      reason: CommandJournalReason = 'rpc-unknown',
    ) {
      const { cmd_id, result } = claim(action)
      assert.ok(result.ok, action)
      assert.ok(markWriteStarted(journal, result.receipt))
      assert.ok(
        finishCommand(journal, result.receipt, 'outcome-unknown', reason),
      )
      return cmd_id
    },
    outcome: (cmdId: string) => readCommandOutcome(journal, cmdId)?.status,
    advance(ms: number) {
      now += ms
    },
    reopen() {
      closeCommandJournal(journal)
      journal = open()
    },
  }
}

for (const reason of ['rpc-unknown', 'state-unconfirmed'] as const)
  test(`journal: a ${reason} firmware restart holds for the documented time only`, (t) => {
    const f = journalFixture(t)
    const restart = f.unknown('firmware_restart', reason)
    assert.equal(FIRMWARE_RESTART_HOLD_MS, 60_000)
    f.advance(FIRMWARE_RESTART_HOLD_MS - 1)
    for (const action of ['pause', 'cancel', 'firmware_restart'] as const)
      assert.deepEqual(f.claim(action).result, BUSY, action)
    f.advance(1)
    assert.ok(f.claim('pause').result.ok)
    // The restart itself was never confirmed.
    assert.equal(f.outcome(restart), 'outcome-unknown')
  })

test('journal: cancel works once the hold expires', (t) => {
  const f = journalFixture(t)
  f.unknown('firmware_restart')
  f.advance(FIRMWARE_RESTART_HOLD_MS)
  assert.ok(f.claim('cancel').result.ok)
})

test('journal: emergency stop is admitted throughout the hold', (t) => {
  const f = journalFixture(t)
  const { result } = f.claim('firmware_restart')
  assert.ok(result.ok)
  // While the restart is still in flight, and after it ends unknown.
  assert.ok(f.claim('emergency_stop').result.ok)
  const g = journalFixture(t)
  g.unknown('firmware_restart')
  assert.ok(g.claim('emergency_stop').result.ok)
})

test('journal: a restart still in flight is not released by time', (t) => {
  const f = journalFixture(t)
  assert.ok(f.claim('firmware_restart').result.ok)
  f.advance(FIRMWARE_RESTART_HOLD_MS * 2)
  assert.deepEqual(f.claim('pause').result, BUSY)
})

test('journal: the hold does not survive a Connector restart', (t) => {
  for (const stage of ['claimed', 'write-started', 'outcome-unknown']) {
    const f = journalFixture(t)
    let restart: string
    if (stage === 'outcome-unknown') restart = f.unknown('firmware_restart')
    else {
      const claimed = f.claim('firmware_restart')
      assert.ok(claimed.result.ok)
      restart = claimed.cmd_id
    }
    f.reopen()
    assert.equal(f.outcome(restart), 'outcome-unknown', stage)
    // The restart cap still counts the unconfirmed restart.
    assert.deepEqual(
      f.claim('firmware_restart').result,
      { ok: false, reason: 'rate-limited' },
      stage,
    )
    assert.ok(f.claim('pause').result.ok, stage)
  }
})

test('journal: other unconfirmed commands keep holding the printer', (t) => {
  for (const action of ['pause', 'cancel', 'emergency_stop'] as const) {
    const f = journalFixture(t)
    f.unknown(action)
    f.advance(FIRMWARE_RESTART_HOLD_MS)
    assert.deepEqual(f.claim('resume').result, BUSY, action)
    f.reopen()
    assert.deepEqual(f.claim('resume').result, BUSY, action)
  }
})

async function dispatcherFixture(t: TestContext) {
  const authority = await createV2Authority(await nodeSigner())
  const directory = mkdtempSync(join(tmpdir(), 'rv-938-dispatch-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const actions: ExtendedControlAction[] = [
    'pause',
    'firmware_restart',
    'emergency_stop',
  ]
  const sent: ExtendedControlAction[] = []
  const open = async (printState: 'idle' | 'printing', now: number) => {
    const d = await openV2Dispatch(authority, {
      directory,
      now,
      capability: { actions },
      // No origin is dialled; the driver below is entirely fake.
      loopback: {
        origin: 'http://127.0.0.1:7125',
        driver({ clock, observe }) {
          let sequence = 0
          let state: 'idle' | 'printing' | 'paused' = printState
          const observation = () => {
            const mono = clock.monotonicNow()
            return {
              assignmentId: authority.ids.assignment_id,
              printerKey: authority.printerKey,
              connectionGeneration: 1,
              sequence: ++sequence,
              ready: true,
              printState: state,
              readyObservedMono: mono,
              printStateObservedMono: mono,
              receivedMono: mono,
            }
          }
          let restarted = false
          return {
            async detect() {},
            controls: () => actions,
            async prepare({ binding }) {
              restarted = false
              observe(binding, observation())
              return { connectionGeneration: 1 }
            },
            async closeAttempt() {},
            async execute(action, _args, { beforeSend }) {
              if (!beforeSend()) return { acknowledged: false }
              sent.push(action)
              restarted = action === 'firmware_restart'
              if (action === 'pause') state = 'paused'
              return { acknowledged: true }
            },
            async pauseOnce() {
              return { acknowledged: false }
            },
            // The Moonraker driver throws when a restart drops the read-back.
            async waitForPaused() {
              if (restarted) throw new Error('Klippy disconnected')
              await new Promise((resolve) => setTimeout(resolve, 5))
              return observation()
            },
          }
        },
      },
    })
    t.after(d.close)
    return {
      d,
      async send(action: ExtendedControlAction) {
        const result = await d.dispatch(
          await authority.sign(
            {
              action,
              args: {},
              purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
            },
            Math.floor(d.now()),
          ),
        )
        return `${result.kind}:${result.reason}`
      },
    }
  }
  return { open, sent }
}

test('browser: pause works after a firmware restart once the printer is ready', async (t) => {
  const { open, sent } = await dispatcherFixture(t)
  const before = await open('idle', 1000)
  assert.equal(
    await before.send('firmware_restart'),
    'outcome-unknown:rpc-unknown',
  )
  assert.equal(await before.send('pause'), 'rejected:busy')
  before.d.close()
  // The Connector restarts and the printer comes back ready and printing.
  const after = await open('printing', 2000)
  assert.equal(await after.send('pause'), 'applied:applied')
  assert.deepEqual(sent, ['firmware_restart', 'pause'])
})

test('browser: emergency stop is sent while a restart holds the printer', async (t) => {
  const f = await dispatcherFixture(t)
  const d = await f.open('idle', 1000)
  assert.equal(await d.send('firmware_restart'), 'outcome-unknown:rpc-unknown')
  assert.equal(await d.send('pause'), 'rejected:busy')
  assert.match(await d.send('emergency_stop'), /^(applied|outcome-unknown):/)
  assert.deepEqual(f.sent, ['firmware_restart', 'emergency_stop'])
})
