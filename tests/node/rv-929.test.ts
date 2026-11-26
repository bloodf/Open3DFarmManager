// #929: every printer restart shares one 1/min cap, whichever action sends it.
// Journal, browser dispatcher and API runner, all against fake drivers: nothing
// here contacts a printer.
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  claimApiCommand,
  claimCommand,
  closeCommandJournal,
  finishCommand,
  markWriteStarted,
  openCommandJournal,
  type CommandClaimHandle,
  type CommandJournalOutcome,
  type CommandJournalReason,
} from '../../packages/connector/src/control/command-journal.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  ControlArguments,
  type ExtendedControlAction,
} from '../../packages/farm-protocol/src/control-actions.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

const SHA = 'a'.repeat(64)
type Command = [ExtendedControlAction, Record<string, unknown>]
const config = { path: 'printer.cfg', base_sha256: SHA }
const SAVE: Command = ['config_write', { ...config, sha256: SHA }]
const SERVICE: Command = ['service', { op: 'klipper_restart' }]
const FIRMWARE: Command = ['firmware_restart', {}]
const SAVE_RESTART: Command = [
  'config_write',
  { ...config, sha256: SHA, restart: true },
]
/** Every way a command can restart the printer. */
const RESTARTS: Record<string, Command> = {
  firmware_restart: FIRMWARE,
  'service klipper_restart': SERVICE,
  'service firmware_restart': ['service', { op: 'firmware_restart' }],
  'service moonraker_restart': ['service', { op: 'moonraker_restart' }],
  'config save with restart': SAVE_RESTART,
  'config restore with restart': [
    'config_write',
    {
      ...config,
      backup: 'printer.cfg.openfarm-1000000000000.bak',
      restart: true,
    },
  ],
}

const IDS = {
  farm_id: randomUUID(),
  agent_id: randomUUID(),
  account_id: 'text_account',
  key_id: randomUUID(),
  transport_id: randomUUID(),
  capability_id: randomUUID(),
  assignment_id: randomUUID(),
}

function journalFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-929-journal-'))
  let now = 100_000
  const open = () => openCommandJournal({ directory, clock: () => now })
  let journal = open()
  t.after(() => {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  function claim([action, args]: Command, printerKey = 'printer') {
    assert.ok(ControlArguments.safeParse({ action, args }).success, action)
    return claimCommand(journal, {
      command: {
        v: 2,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        cmd_id: randomUUID(),
        ...IDS,
        // One assignment per printer, as the Connector provisions them.
        assignment_id:
          printerKey === 'printer' ? IDS.assignment_id : randomUUID(),
        action,
        args,
        issued_at: now,
        expires_at: now + 5000,
        nonce: randomBytes(16).toString('base64url'),
        sig: 'A'.repeat(86),
      },
      printerKey,
      wireSha256: SHA,
    })
  }
  function finish(
    receipt: CommandClaimHandle,
    outcome: CommandJournalOutcome,
    reason: CommandJournalReason,
  ) {
    assert.ok(finishCommand(journal, receipt, outcome, reason))
  }
  return {
    claim,
    finish,
    /** Claims and completes a command; returns `ok` or the refusal reason. */
    run(command: Command, printerKey?: string): string {
      const result = claim(command, printerKey)
      if (!result.ok) return result.reason
      assert.ok(markWriteStarted(journal, result.receipt))
      finish(result.receipt, 'applied', 'applied')
      return 'ok'
    },
    mark(receipt: CommandClaimHandle) {
      assert.ok(markWriteStarted(journal, receipt))
    },
    advance(ms: number) {
      now += ms
    },
    reopen(whileClosed?: () => void) {
      closeCommandJournal(journal)
      whileClosed?.()
      journal = open()
    },
    directory,
    get journal() {
      return journal
    },
  }
}

for (const [first, command] of Object.entries(RESTARTS))
  test(`journal: ${first} spends the one restart of every other path`, (t) => {
    const f = journalFixture(t)
    assert.equal(f.run(command), 'ok')
    for (const [second, other] of Object.entries(RESTARTS))
      assert.equal(f.run(other), 'rate-limited', second)
    // Only restarts are held back, and only on this printer.
    assert.equal(f.run(['pause', {}]), 'ok')
    assert.equal(f.run(command, 'other-printer'), 'ok')
  })

test('journal: the restart window expires after 60 seconds', (t) => {
  const f = journalFixture(t)
  assert.equal(f.run(FIRMWARE), 'ok')
  f.advance(59_999)
  assert.equal(f.run(SERVICE), 'rate-limited')
  assert.equal(f.run(SAVE_RESTART), 'rate-limited')
  f.advance(1)
  assert.equal(f.run(SAVE_RESTART), 'ok')
  // The window slides: the new restart holds it for another minute, and the
  // refused attempts above never extended it.
  assert.equal(f.run(FIRMWARE), 'rate-limited')
  f.advance(60_000)
  assert.equal(f.run(FIRMWARE), 'ok')
})

test('journal: a restart refused before the send does not use the cap', (t) => {
  const f = journalFixture(t)
  for (const written of [false, true]) {
    const refused = f.claim(FIRMWARE)
    assert.ok(refused.ok)
    // The final guard may refuse after write-started was already recorded.
    if (written) f.mark(refused.receipt)
    f.finish(refused.receipt, 'not-sent', 'guard-denied')
  }
  assert.equal(f.run(SERVICE), 'ok')
  assert.equal(f.run(FIRMWARE), 'rate-limited')
})

test('journal: a restart in progress or with an unknown outcome counts', (t) => {
  const f = journalFixture(t)
  const claimed = f.claim(SERVICE)
  assert.ok(claimed.ok)
  // Still in progress: the printer is busy before any cap is reached.
  assert.deepEqual(f.claim(FIRMWARE), { ok: false, reason: 'assignment-busy' })
  f.mark(claimed.receipt)
  // An unconfirmed service restart releases the printer but keeps the cap.
  f.finish(claimed.receipt, 'outcome-unknown', 'state-unconfirmed')
  assert.equal(f.run(FIRMWARE), 'rate-limited')
  assert.equal(f.run(['pause', {}]), 'ok')
})

test('journal: a save with restart also uses the config-save cap', (t) => {
  const f = journalFixture(t)
  assert.equal(f.run(SAVE_RESTART), 'ok')
  assert.equal(f.run(SAVE), 'ok')
  assert.equal(f.run(SAVE), 'rate-limited')
  f.advance(60_000)
  assert.equal(f.run(SAVE), 'ok')
  assert.equal(f.run(SAVE), 'ok')
  // The save cap is spent, so no restart is claimed either.
  assert.equal(f.run(SAVE_RESTART), 'rate-limited')
  assert.equal(f.run(FIRMWARE), 'ok')
})

test('journal: the restart cap survives a Connector restart', (t) => {
  const f = journalFixture(t)
  assert.equal(f.run(SAVE_RESTART), 'ok')
  f.reopen()
  assert.equal(f.run(FIRMWARE), 'rate-limited')
})

test('journal: upgrading a version 18 journal keeps recent restart actions', (t) => {
  for (const command of [FIRMWARE, SERVICE]) {
    const f = journalFixture(t)
    assert.equal(f.run(command), 'ok')
    f.reopen(() => {
      const database = new DatabaseSync(
        join(f.directory, 'pause-commands.sqlite'),
      )
      // Version 18 also predates the camera-stream and filament-slot actions.
      const actions = String(
        database
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE name='control_command_actions'",
          )
          .get()!.sql,
      ).replace(",'set_camera_stream','set_filament_slot'", '')
      database.exec(
        `ALTER TABLE control_command_actions RENAME TO current_actions; ${actions}; INSERT INTO control_command_actions SELECT cmd_id,action FROM current_actions; DROP TABLE current_actions`,
      )
      database.exec(
        'DROP TABLE control_command_restarts; PRAGMA user_version=18',
      )
      database.close()
    })
    assert.equal(f.run(SAVE_RESTART), 'rate-limited', command[0])
  }
})

// --- Browser dispatcher -----------------------------------------------------

/** The command was claimed and handed to the driver, whatever its read-back. */
const RAN = /^(applied|outcome-unknown):/

/** The shipped dispatcher with an owner capability and a counting driver. */
async function browser(t: TestContext) {
  const authority = await createV2Authority(await nodeSigner())
  const sent: ExtendedControlAction[] = []
  const driverState = { mode: 'ack' as 'ack' | 'refuse' | 'lost' }
  const actions: ExtendedControlAction[] = [
    'pause',
    'firmware_restart',
    'service',
    'config_write',
  ]
  const d = await openV2Dispatch(authority, {
    capability: { role: 'owner', actions },
    // Used only so this driver can report an idle printer; no origin is dialled.
    loopback: {
      origin: 'http://127.0.0.1:7125',
      driver({ clock, observe }) {
        let sequence = 0
        const observation = () => {
          const mono = clock.monotonicNow()
          return {
            assignmentId: authority.ids.assignment_id,
            printerKey: authority.printerKey,
            connectionGeneration: 1,
            sequence: ++sequence,
            ready: true,
            printState: 'idle' as const,
            readyObservedMono: mono,
            printStateObservedMono: mono,
            receivedMono: mono,
          }
        }
        return {
          async detect() {},
          controls: () => actions,
          async prepare({ binding }) {
            observe(binding, observation())
            return { connectionGeneration: 1 }
          },
          async closeAttempt() {},
          async execute(action, _args, { beforeSend }) {
            if (driverState.mode === 'refuse')
              throw new DriverRefusalError('state', 'Refused before sending')
            if (!beforeSend()) return { acknowledged: false }
            sent.push(action)
            if (driverState.mode === 'lost') throw new Error('socket lost')
            return { acknowledged: true }
          },
          async pauseOnce() {
            return { acknowledged: false }
          },
          // A restart drops the read-back, as the Moonraker driver reports it.
          async waitForPaused() {
            return null as never
          },
        }
      },
    },
  })
  t.after(d.close)
  return {
    sent,
    driverState,
    async send([action, args]: Command) {
      const result = await d.dispatch(
        await authority.sign(
          { action, args, purpose: 'printer-control' },
          Math.floor(d.now()),
        ),
      )
      return `${result.kind}:${result.reason}`
    },
  }
}

test('browser: service then firmware_restart or a save with restart is refused', async (t) => {
  const f = await browser(t)
  assert.equal(await f.send(SERVICE), 'outcome-unknown:state-unconfirmed')
  // The dispatcher reports a journal rate limit as `storage`.
  assert.equal(await f.send(FIRMWARE), 'rejected:storage')
  assert.equal(await f.send(SAVE_RESTART), 'rejected:storage')
  assert.deepEqual(f.sent, ['service'])
  // The journal is healthy: a save without restart still runs.
  assert.match(await f.send(SAVE), RAN)
})

test('browser: a save with restart then firmware_restart or service is refused', async (t) => {
  const f = await browser(t)
  assert.equal(await f.send(SAVE_RESTART), 'applied:applied')
  assert.equal(await f.send(FIRMWARE), 'rejected:storage')
  assert.equal(await f.send(SERVICE), 'rejected:storage')
  assert.equal(await f.send(SAVE_RESTART), 'rejected:storage')
  assert.deepEqual(f.sent, ['config_write'])
})

test('browser: a sent firmware_restart never allows a second restart', async (t) => {
  const f = await browser(t)
  assert.equal(await f.send(FIRMWARE), 'outcome-unknown:state-unconfirmed')
  // An unconfirmed firmware restart also keeps holding the printer.
  assert.equal(await f.send(FIRMWARE), 'rejected:busy')
  assert.equal(await f.send(SAVE_RESTART), 'rejected:busy')
  assert.deepEqual(f.sent, ['firmware_restart'])
})

test('browser: a driver refusal before the send leaves the restart available', async (t) => {
  const f = await browser(t)
  f.driverState.mode = 'refuse'
  assert.equal(await f.send(SERVICE), 'not-sent:state')
  assert.equal(await f.send(SAVE_RESTART), 'not-sent:state')
  f.driverState.mode = 'ack'
  assert.equal(await f.send(SAVE_RESTART), 'applied:applied')
  assert.deepEqual(f.sent, ['config_write'])
})

test('browser: a restart lost after the send is not repeated', async (t) => {
  const f = await browser(t)
  f.driverState.mode = 'lost'
  assert.equal(await f.send(SERVICE), 'outcome-unknown:rpc-unknown')
  f.driverState.mode = 'ack'
  assert.equal(await f.send(FIRMWARE), 'rejected:busy')
  assert.deepEqual(f.sent, ['service'])
})

// --- API command path -------------------------------------------------------

const APP = randomUUID()
const GRANT = randomUUID()

async function apiRunner(f: ReturnType<typeof journalFixture>) {
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  // The envelope clock matches the journal fixture's starting time.
  const now = 100_000
  const clock = { wallNow: () => now, monotonicNow: () => 1000 }
  const origin = 'http://127.0.0.1:7125'
  const binding = createPrinterBindingRegistry({
    allowedOrigins: [origin],
  }).provision({
    assignment_id: IDS.assignment_id,
    farm_id: IDS.farm_id,
    agent_id: IDS.agent_id,
    printer_key: 'printer',
    moonraker_origin: origin,
  })
  const authority = createOfflineAuthority()
  authority.confirm({ wall: now, mono: 1000 }, 1)
  const sent: string[] = []
  const reports: ReturnType<typeof decodeApiEnvelopeResultFrame>[] = []
  const runner = createApiCommandRunner({
    farmId: IDS.farm_id,
    agentId: IDS.agent_id,
    keys: { issuer: () => issuer.publicKey },
    grants: {
      lookup: () => ({
        grant_id: GRANT,
        app_id: APP,
        farm_id: IDS.farm_id,
        scopes: ['control:basic', 'control:extended'],
        revoked: false,
      }),
      freshness: authority.freshness,
    },
    journal: f.journal,
    printer: () => binding,
    observe: () => ({ ready: true, printState: 'printing' }),
    driver: {
      async prepare() {
        return { connectionGeneration: 1 }
      },
      controls: () => ['pause'],
      async execute(action, _args, input) {
        if (!input.beforeSend()) return { acknowledged: false }
        sent.push(action)
        return { acknowledged: true }
      },
    },
    report: (wire) => reports.push(decodeApiEnvelopeResultFrame(wire)),
    clock,
  })
  const claims = (action: Record<string, unknown>) => ({
    v: 1,
    purpose: 'api-envelope',
    issuer: API_ENVELOPE_ISSUER,
    kid: 'api-1',
    app_id: APP,
    grant_id: GRANT,
    farm_id: IDS.farm_id,
    agent_id: IDS.agent_id,
    assignment_id: IDS.assignment_id,
    resource_id: randomUUID(),
    cmd_id: randomUUID(),
    nonce: newApiEnvelopeNonce(),
    issued_at: now,
    expires_at: now + 60_000,
    kind: 'action',
    action,
  })
  return {
    sent,
    reports,
    claims,
    sign: (action: Record<string, unknown>) =>
      signApiEnvelope(claims(action), issuer.privateKey),
    async pause() {
      return runner.run(
        encodeApiEnvelopeFrame({
          v: 1,
          t: 'api-envelope.command',
          envelope: await signApiEnvelope(
            claims({ action: 'pause', args: {} }),
            issuer.privateKey,
          ),
        }),
      )
    },
  }
}

test('API: no envelope can carry a restart, signed or claimed', async (t) => {
  const f = journalFixture(t)
  const api = await apiRunner(f)
  for (const [name, [action, args]] of Object.entries(RESTARTS)) {
    await assert.rejects(api.sign({ action, args }), name)
    assert.deepEqual(
      claimApiCommand(f.journal, {
        envelope: api.claims({ action, args }) as never,
        printerKey: 'printer',
        wireSha256: SHA,
      }),
      { ok: false, reason: 'storage-unavailable' },
      name,
    )
  }
  // None of those attempts touched the restart cap.
  assert.equal(f.run(FIRMWARE), 'ok')
})

test('API: commands share the journal without using or lifting the restart cap', async (t) => {
  const f = journalFixture(t)
  const api = await apiRunner(f)
  assert.deepEqual(await api.pause(), { kind: 'completed' })
  assert.equal(f.run(FIRMWARE), 'ok')
  assert.deepEqual(await api.pause(), { kind: 'completed' })
  assert.equal(f.run(SERVICE), 'rate-limited')
  // A browser restart uses one of the ten shared claims the API also uses:
  // two API pauses and one restart so far.
  for (let i = 0; i < 7; i++)
    assert.deepEqual(await api.pause(), { kind: 'completed' })
  const refused = await api.pause()
  assert.equal(refused.kind, 'refused')
  assert.equal(api.reports.at(-1)?.refusal_code, 'printer-busy')
  assert.equal(api.sent.length, 9)
})
