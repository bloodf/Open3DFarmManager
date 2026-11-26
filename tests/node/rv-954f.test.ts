// #956: guards of the #954 follow-ups, each on its own. Simulators and fake
// drivers only: no real printer is contacted.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import {
  createPauseCommandRelay,
  PAUSE_RELAY_MAX_COMMANDS,
} from '../../packages/connector/src/control/pause-command-relay.ts'
import type { PreparedPauseDriver } from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  createPrinterBindingRegistry,
  readPrinterBinding,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedFlashforgeControl } from '../../packages/connector/src/flashforge/control-driver.ts'
import type { FlashforgeQualification } from '../../packages/connector/src/flashforge/qualification.ts'
import {
  decodeCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  controlSourceState,
  type ExtendedControlAction,
} from '../../packages/farm-protocol/src/control-actions.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodePauseAdmissionProof,
  encodePauseCapability,
  signPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'
import {
  AD5X,
  MODELS,
  open,
  printer,
  QUALIFIED,
  request,
  signed,
} from '../helpers/flashforge-dispatch.ts'

const FIVE_M_PRO = MODELS[1]!
const CAMERA_NEEDED =
  'A câmera não pode ser desligada durante uma impressão, para não interromper o monitoramento remoto.'

for (const [model, status, action, args] of [
  [FIVE_M_PRO, 'printing', 'pause', {}],
  [FIVE_M_PRO, 'ready', 'set_camera_stream', { on: false }],
  [
    AD5X,
    'ready',
    'set_filament_slot',
    { tray: 1, material: 'PETG', color: '#112233' },
  ],
] as const)
  test(`Flashforge ${action}: a send-time dispatcher veto writes nothing`, async (t) => {
    // Authority ends after every pre-send check, while the driver is sending.
    const target = await signed(t, model, QUALIFIED, (revoke) => revoke())
    target.sim.detail.status = status
    target.sim.detail.printFileName = 'fixture.gcode'
    const result = await target.run(action, args)
    assert.equal(result.kind, 'not-sent', JSON.stringify(result))
    assert.deepEqual(target.guards, [false])
    assert.deepEqual(target.sim.writes, [])
  })

test('set_filament_slot is admitted only from an idle printer state', () => {
  for (const state of [
    'idle',
    'printing',
    'paused',
    'cancelled',
    'error',
    'unknown',
  ])
    assert.equal(
      controlSourceState('set_filament_slot', state),
      state === 'idle',
      state,
    )
})

test('the dispatcher alone keeps set_filament_slot off a printing printer', async (t) => {
  const authority = await createV2Authority(await nodeSigner())
  // The fake driver has no idle check of its own and reports `printing`.
  const session = await openV2Dispatch(authority, {
    controls: ['set_filament_slot'],
    capability: { role: 'owner', actions: ['set_filament_slot'] },
  })
  t.after(() => session.close())
  const result = await session.dispatch(
    await authority.sign({
      purpose: 'printer-control',
      action: 'set_filament_slot',
      args: { tray: 1, material: 'PETG', color: '#112233' },
    }),
  )
  assert.equal(result.kind, 'not-sent', JSON.stringify(result))
  assert.equal('reason' in result && result.reason, 'state')
  assert.equal(session.driverEntries(), 0)
})

test('the send callback re-checks the qualification on its own', async (t) => {
  const target = await printer(t, MODELS[0]!)
  target.sim.detail.status = 'printing'
  target.sim.detail.printFileName = 'fixture.gcode'
  // The driver's pre-write check and the adapter's own gate both pass; the
  // pair is withdrawn only for the third look, inside the send callback.
  const qualified: FlashforgeQualification[] = [...QUALIFIED]
  let looks = 0
  qualified.some = (predicate) =>
    ++looks < 3 && Array.prototype.some.call(qualified, predicate)
  const driver = openFixedFlashforgeControl({
    binding: target.binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: () => {},
    signal: new AbortController().signal,
    pollMs: 20,
    timeoutMs: 1000,
    qualifiedWrites: qualified,
  })
  t.after(() => driver.close())
  await driver.prepare()
  const sent = { count: 0 }
  await assert.rejects(
    driver.driver.execute!('pause', {}, request(target.binding, sent)),
    (error: unknown) =>
      error instanceof DriverRefusalError &&
      error.refusal === 'unsupported-action' &&
      /ainda não foram qualificados/.test(error.userMessage ?? ''),
  )
  assert.equal(looks, 3)
  assert.equal(sent.count, 0)
  assert.deepEqual(target.sim.writes, [])
})

for (const status of ['printing', 'pause'])
  test(`a signed camera off is refused while the printer reports ${status}`, async (t) => {
    const target = await signed(t, FIVE_M_PRO, QUALIFIED)
    target.sim.detail.status = status
    target.sim.detail.printFileName = 'fixture.gcode'
    const result = await target.run('set_camera_stream', { on: false })
    assert.equal(result.kind, 'not-sent', JSON.stringify(result))
    assert.equal('message' in result && result.message, CAMERA_NEEDED)
    assert.deepEqual(target.sim.writes, [])
    // Turning the remote view back on stays allowed during a print.
    target.sim.detail.cameraStreamUrl = ''
    const on = await target.run('set_camera_stream', { on: true })
    assert.equal(on.kind, 'applied', JSON.stringify(on))
    assert.equal(target.sim.writes.length, 1)
  })

test('camera off is judged on the send-time read, not the earlier report', async (t) => {
  for (const status of ['printing', 'heating', 'busy']) {
    const target = await printer(t, FIVE_M_PRO)
    const driver = await open(t, target.binding)
    target.sim.detail.status = status
    const sent = { count: 0 }
    await assert.rejects(
      driver.driver.execute!(
        'set_camera_stream',
        { on: false },
        request(target.binding, sent),
      ),
      (error: unknown) =>
        error instanceof DriverRefusalError &&
        error.refusal === 'state' &&
        error.userMessage === CAMERA_NEEDED,
      status,
    )
    assert.equal(sent.count, 0, status)
    assert.deepEqual(target.sim.writes, [], status)
    await driver.close()
  }
})

type Authority = Awaited<ReturnType<typeof createV2Authority>>

/**
 * The shipped relay and dispatcher over a real journal and a local driver
 * double. Every peer is genuinely admitted for its own transport.
 */
async function relayFixture(
  t: TestContext,
  options: { refuseStop?: boolean } = {},
) {
  const base = await createV2Authority(await nodeSigner())
  const directory = mkdtempSync(join(tmpdir(), 'rv-954f-relay-'))
  const journal = openCommandJournal({ directory, clock: Date.now })
  const registry = createPrinterBindingRegistry({
    allowedOrigins: ['https://farm.example'],
  })
  const bindings = new Map<string, PrinterBinding>()
  const sent: ExtendedControlAction[] = []
  let sequence = 0
  const observation = (binding: PrinterBinding) => {
    const mapping = readPrinterBinding(binding)!
    const mono = performance.now()
    return {
      assignmentId: mapping.assignment_id,
      printerKey: mapping.printer_key,
      connectionGeneration: 1,
      sequence: ++sequence,
      ready: true,
      printState: 'printing' as const,
      readyObservedMono: mono,
      printStateObservedMono: mono,
      receivedMono: mono,
    }
  }
  const driver: PreparedPauseDriver = {
    controls: () => ['pause', 'emergency_stop'],
    async prepare({ binding }) {
      relay.observe(binding, observation(binding))
      return { connectionGeneration: 1 }
    },
    async closeAttempt() {},
    async execute(action, _args, { beforeSend }) {
      if (options.refuseStop && action === 'emergency_stop')
        throw new DriverRefusalError('state', 'Stop refused before writing')
      if (!beforeSend()) return { acknowledged: false }
      sent.push(action)
      return { acknowledged: true }
    },
    async pauseOnce() {
      return { acknowledged: false }
    },
    async waitForPaused({ binding }) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return observation(binding)
    },
  }
  const relay = createPauseCommandRelay({
    authority: {
      freshness: { freshAt: () => true },
      issuers: [
        {
          issuer: 'farm:issuer',
          kid: 'issuer-1',
          publicKey: base.issuer.publicKey,
        },
      ],
    },
    clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
    journal,
    driver,
    bindingFor: (assignmentId) => bindings.get(assignmentId),
  })
  t.after(async () => {
    relay.close()
    await relay.settled
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  /** One admitted peer, on the given printer. Returns its command sender. */
  async function peer(assignmentId: string) {
    const ids = {
      ...base.ids,
      assignment_id: assignmentId,
      transport_id: randomUUID(),
      capability_id: randomUUID(),
    }
    const printerKey = `printer-${assignmentId}`
    const printerBinding =
      bindings.get(assignmentId) ??
      registry.provision({
        assignment_id: assignmentId,
        farm_id: ids.farm_id,
        agent_id: ids.agent_id,
        printer_key: printerKey,
        moonraker_origin: 'https://farm.example',
      })
    bindings.set(assignmentId, printerBinding)
    const now = Date.now()
    const binding: Authority['binding'] = {
      ...base.binding,
      assignment_id: assignmentId,
      transport_id: ids.transport_id,
      issued_at: now,
      expires_at: now + 30000,
    }
    let nonce = ''
    assert.ok(
      relay.openPeer({
        binding,
        browserProofWire: encodeControlProof({
          v: 1,
          role: 'browser',
          binding,
          signature: await base.signer.signControlProof(binding),
        }),
        connectorProofWire: encodeControlProof({
          v: 1,
          role: 'connector',
          binding,
          signature: await signControlSessionProof(
            binding,
            'connector',
            base.connector.privateKey,
          ),
        }),
        sendPhase(message) {
          if (message.t === 'control.admission-nonce')
            nonce = message.admission_nonce
          return true
        },
        sendResult: () => true,
      }),
    )
    const bindingHash = await controlBindingHash(binding)
    const claims = {
      farm_id: ids.farm_id,
      agent_id: ids.agent_id,
      key_id: ids.key_id,
      assignment_id: assignmentId,
      transport_id: ids.transport_id,
      account_id: ids.account_id,
      browser_thumbprint: base.thumbprint,
      origin: binding.origin,
      audience: binding.audience,
      control_binding_sha256: bindingHash,
      admission_nonce: nonce,
      issued_at: Date.now(),
    }
    const admitted = await relay.admitPeer({
      transportId: ids.transport_id,
      capabilityWire: encodePauseCapability(
        await signPauseCapability(
          {
            ...claims,
            v: 1,
            purpose: 'pause-authority',
            capability_id: ids.capability_id,
            kid: 'issuer-1',
            issuer: 'farm:issuer',
            expires_at: binding.expires_at,
            role: 'operator',
            browser_public_key: base.publicKey,
            connector_fingerprint: binding.connector_fingerprint,
            credential_jti: binding.credential_jti,
            printer_key: printerKey,
            actions: ['pause', 'emergency_stop'],
          },
          base.issuer.privateKey,
        ),
      ),
      admissionProofWire: encodePauseAdmissionProof(
        await base.signer.signAdmissionProof({
          ...claims,
          v: 1,
          purpose: 'pause-admission',
          challenge_id: randomUUID(),
          expires_at: claims.issued_at + 8000,
        }),
      ),
    })
    assert.deepEqual(admitted, { ok: true })
    return async (
      action: 'pause' | 'emergency_stop',
      signature?: Uint8Array,
    ) => {
      const issuedAt = Date.now()
      const signedWire = await base.signer.signCommand(
        base.command(
          {
            ...ids,
            action,
            purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
            nonce: randomBytes(16).toString('base64url'),
          },
          issuedAt,
        ),
      )
      const command = decodeCommandV2(encodeCommandV2(signedWire))
      const wire = encodeCommandV2(
        signature
          ? { ...command, sig: Buffer.from(signature).toString('base64url') }
          : command,
      )
      // Wrapped so that awaiting the sender never awaits the outcome.
      return {
        outcome: relay.commandPeer({ transportId: ids.transport_id, wire }),
      }
    }
  }
  return { relay, peer, sent }
}

/** Holds every verification of `signature` until released. */
function holdVerification(t: TestContext, signature: Uint8Array) {
  const release = Promise.withResolvers<void>()
  const verify = crypto.subtle.verify.bind(crypto.subtle)
  const held = { count: 0, release: release.resolve }
  t.mock.method(
    crypto.subtle,
    'verify',
    async (...args: Parameters<SubtleCrypto['verify']>) => {
      if (
        ArrayBuffer.isView(args[2]) &&
        Buffer.from(
          args[2].buffer,
          args[2].byteOffset,
          args[2].byteLength,
        ).equals(signature)
      ) {
        held.count++
        await release.promise
      }
      return verify(...args)
    },
  )
  return held
}

const turn = () => new Promise((resolve) => setImmediate(resolve))

for (const bad of ['emergency_stop', 'pause'] as const)
  for (const samePrinter of [true, false])
    test(
      `eight bad-signature ${bad} peers on ${samePrinter ? 'one printer' : 'eight printers'} do not delay a genuine stop`,
      { timeout: 10000 },
      async (t) => {
        const f = await relayFixture(t)
        const target = randomUUID()
        const peers = []
        for (let index = 0; index < PAUSE_RELAY_MAX_COMMANDS; index++)
          peers.push(await f.peer(samePrinter ? target : randomUUID()))
        const genuine = await f.peer(target)
        const signature = new Uint8Array(64)
        const held = holdVerification(t, signature)
        const outcomes = []
        for (const send of peers)
          outcomes.push((await send(bad, signature)).outcome)
        try {
          // Stops and distinct printers all reach verification; a second pause
          // for one printer is refused at once.
          const holding = bad === 'pause' && samePrinter ? 1 : peers.length
          // Bounded, so a regression fails on the assertions, not by hanging.
          const deadline = Date.now() + 2000
          while (held.count < holding && Date.now() < deadline) await turn()
          const stop = await genuine('emergency_stop')
          assert.equal(await stop.outcome, 'outcome-unknown')
          assert.deepEqual(f.sent, ['emergency_stop'])
          assert.equal(held.count, holding)
        } finally {
          held.release()
        }
        assert.deepEqual(
          await Promise.all(outcomes),
          peers.map(() => 'rejected'),
        )
      },
    )

for (const refuseStop of [false, true])
  test(
    `a pause still unverified when a ${refuseStop ? 'refused' : 'sent'} stop takes its printer is never sent`,
    { timeout: 10000 },
    async (t) => {
      // A refused stop leaves no journal row to hold the pause back.
      const f = await relayFixture(t, { refuseStop })
      const target = randomUUID()
      const pauser = await f.peer(target)
      const stopper = await f.peer(target)
      const release = Promise.withResolvers<void>()
      const verifying = Promise.withResolvers<void>()
      const verify = crypto.subtle.verify.bind(crypto.subtle)
      let first = true
      t.mock.method(
        crypto.subtle,
        'verify',
        async (...args: Parameters<SubtleCrypto['verify']>) => {
          if (first) {
            first = false
            verifying.resolve()
            await release.promise
          }
          return verify(...args)
        },
      )
      const pause = await pauser('pause')
      try {
        await verifying.promise
        const stop = await stopper('emergency_stop')
        assert.equal(
          await stop.outcome,
          refuseStop ? 'not-sent' : 'outcome-unknown',
        )
      } finally {
        release.resolve()
      }
      assert.equal(await pause.outcome, 'rejected')
      assert.equal(f.relay.diagnostics().lastReason, 'busy')
      assert.deepEqual(f.sent, refuseStop ? [] : ['emergency_stop'])
    },
  )
