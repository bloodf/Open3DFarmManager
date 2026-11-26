// #974 review: a HALOT hold through the shipped path. Signed v2 commands go
// through the real pause dispatcher, the durable command journal and the
// production driver router into the HALOT driver, against the loopback HALOT
// simulator with a test-only qualification. Nothing here contacts a printer.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  hasUncertainHold,
  HOLD_AUDIT_FILE,
} from '../../packages/connector/src/control/command-journal.ts'
import { provisionHalotPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import type { HalotQualification } from '../../packages/connector/src/halot/qualification.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  HALOT_SIMULATOR_PASSWORD,
  startHalotSimulator,
} from '../../packages/sim-tools/src/halot-simulator.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
  type V2Authority,
} from '../helpers/command-v2-dispatch.ts'

const MODEL = 'HALOT-MAGE PRO' as const
// The same test-only list as tests/helpers/halot-qualified-connector.ts.
const QUALIFIED: HalotQualification[] = (
  ['pause', 'resume', 'cancel'] as const
).map((operation) => ({
  operation,
  model: MODEL,
  ...(operation === 'cancel' ? { cancelReached: ['TEST_CANCELLED'] } : {}),
}))

async function fixture(t: TestContext, role: 'owner' | 'admin') {
  const sim = await startHalotSimulator()
  t.after(sim.close)
  sim.beginPrint('part.cxdlpv4')
  const directory = await mkdtemp(join(tmpdir(), 'fix-974r-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const origin = `ws://127.0.0.1:${sim.port}`
  const passwordFile = join(directory, 'halot-password.json')
  await writeFile(
    passwordFile,
    JSON.stringify({ origin, password: HALOT_SIMULATOR_PASSWORD }),
    { mode: 0o600 },
  )
  const authority = await createV2Authority(await nodeSigner())
  const journalDirectory = join(directory, 'journal')
  const bindings: unknown[] = []
  /** One Connector run: a fresh binding, router and dispatcher on the journal. */
  async function connector(now: number) {
    const d = await openV2Dispatch(authority, {
      directory: journalDirectory,
      now,
      capability: {
        role,
        actions: ['pause', 'resume', 'cancel', 'clear_hold'],
      },
      provision(scope) {
        const binding = provisionHalotPrinter(scope, {
          family: 'halot',
          printerKey: scope.printer_key,
          origin,
          passwordFile,
          simulated: true,
          expect: { model: MODEL },
        })
        bindings.push(binding)
        return binding
      },
      loopback: {
        origin,
        driver: ({ clock, observe }) =>
          createPauseDriverRouter({
            allowedOrigins: [],
            limits: {} as never,
            clock,
            observe,
            halotQualifiedWrites: QUALIFIED,
          }),
      },
    })
    t.after(d.close)
    return {
      d,
      async send(action: ExtendedControlAction, by: V2Authority = authority) {
        const result = await d.dispatch(
          await by.sign(
            {
              action,
              args: {},
              purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
            },
            Math.floor(d.now()),
          ),
        )
        return result
      },
    }
  }
  const audit = async () =>
    (await readFile(join(journalDirectory, HOLD_AUDIT_FILE), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const holdScope = {
    assignmentId: authority.ids.assignment_id,
    farmId: authority.ids.farm_id,
    printerKey: authority.printerKey,
  }
  return { sim, authority, connector, audit, bindings, holdScope }
}

for (const role of ['owner', 'admin'] as const) {
  test(`an uncertain HALOT pause holds across a Connector restart until ${role} clear_hold`, async (t) => {
    const { sim, authority, connector, audit, bindings, holdScope } =
      await fixture(t, role)

    // 1. The printer applies the pause, but the link drops before any reply
    //    or status read can confirm it.
    const first = await connector(1000)
    sim.setFault('drop-after-command')
    const lost = await first.send('pause')
    assert.equal(lost.kind, 'outcome-unknown', JSON.stringify(lost))
    assert.equal(lost.reason, 'rpc-unknown')
    assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])
    assert.equal(sim.machine.printStatus, 'PRINT_PAUSE')
    assert.equal(hasUncertainHold(first.d.journal, holdScope), true)
    // Nothing is retried on the same run either.
    sim.setFault()
    assert.deepEqual(await first.send('resume'), {
      kind: 'rejected',
      reason: 'busy',
    })
    assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])

    // 2. Connector restart: the dispatcher and journal close, a new binding is
    //    provisioned and the same journal file is reopened.
    first.d.close()
    const after = await connector(2000)
    assert.equal(bindings.length, 2)
    assert.notEqual(bindings[0], bindings[1])
    assert.equal(after.d.printerBinding, bindings[1])
    assert.equal(hasUncertainHold(after.d.journal, holdScope), true)

    // 3. Every later write is refused by the hold before the printer is
    //    contacted; time on the running Connector does not release it.
    for (const action of ['resume', 'pause', 'cancel'] as const)
      assert.deepEqual(
        await after.send(action),
        { kind: 'rejected', reason: 'busy' },
        action,
      )
    after.d.advance(60_000)
    await after.d.readmit()
    assert.deepEqual(await after.send('resume'), {
      kind: 'rejected',
      reason: 'busy',
    })
    assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])
    assert.equal(sim.machine.printStatus, 'PRINT_PAUSE')

    // 4. The owner or admin checked the printer and clears the hold: one
    //    audit line, no printer read or write.
    const reads = sim.received.length
    assert.deepEqual(
      (({ kind, reason }) => ({ kind, reason }))(
        await after.send('clear_hold'),
      ),
      { kind: 'applied', reason: 'applied' },
    )
    assert.equal(sim.received.length, reads, 'clear_hold never reaches HALOT')
    const [entry, ...rest] = await audit()
    assert.equal(rest.length, 0)
    assert.equal(entry.event, 'hold-cleared')
    assert.equal(entry.role, role)
    assert.equal(entry.account_id, authority.ids.account_id)
    assert.equal(entry.key_id, authority.ids.key_id)
    assert.equal(entry.printer_key, authority.printerKey)
    assert.deepEqual(
      entry.cleared.map((row: { action: string }) => row.action),
      ['pause'],
    )
    assert.equal(hasUncertainHold(after.d.journal, holdScope), false)

    // 5. The next write is accepted, sent once and confirmed by status.
    const resumed = await after.send('resume')
    assert.deepEqual(
      { kind: resumed.kind, reason: resumed.reason },
      { kind: 'applied', reason: 'applied' },
      JSON.stringify(resumed),
    )
    assert.deepEqual(sim.writes(), ['PRINT_PAUSE', 'PRINT_PAUSE'])
    assert.equal(sim.machine.printStatus, 'PRINT_PROCESSING')
  })
}
