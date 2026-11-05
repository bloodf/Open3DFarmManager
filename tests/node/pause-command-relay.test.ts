import test from 'node:test'
import assert from 'node:assert/strict'
import {
  randomBytes,
  randomUUID,
  createHash,
  generateKeyPairSync,
} from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openCommandJournal,
  closeCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  createPauseCommandRelay,
  PAUSE_RELAY_MAX_COMMANDS,
  PAUSE_RELAY_MAX_PEERS,
} from '../../packages/connector/src/control/pause-command-relay.ts'
import {
  createPrinterBindingRegistry,
  readPrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import type { PauseDriver } from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  encodeCommandV2,
  decodeCommandV2,
  signCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodePauseAdmissionProof,
  encodePauseCapability,
  signPauseAdmissionProof,
  signPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { PauseControlSession } from '../../packages/connector/src/webrtc/pause-control-session.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { createPauseCommandClient } from '../../apps/farm/app/utils/webrtc/pause-command-client.ts'

const digest = () => randomBytes(32).toString('base64url')

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for state')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Synthetic browser, connector and issuer material with a local printer
 * mapping. No database authority, no control RTC, no Moonraker and no
 * simulator is involved: the driver is a local double.
 */
async function relayFixture(
  t: test.TestContext,
  options: { hold?: boolean } = {},
) {
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  t.after(async () => {
    const errors: unknown[] = []
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Fixture cleanup failed')
  })
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const now = Date.now()
  const farmId = randomUUID()
  const agentId = randomUUID()
  const keyId = randomUUID()
  const baseBinding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: randomUUID(),
    farm_id: farmId,
    agent_id: agentId,
    account_id: 'legacy_account',
    key_id: keyId,
    assignment_id: randomUUID(),
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const registry = createPrinterBindingRegistry({
    allowedOrigins: ['https://farm.example'],
  })
  let printerCounter = 0
  const directory = mkdtempSync(join(tmpdir(), 'pause-command-relay-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  // The monotonic clock is the real monotonic clock: every bound of the relay
  // is then a real bound and the drift check of the verifier stays satisfied.
  const monotonicNow = () => performance.now()
  let releaseHold = () => {}
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve
  })
  let entered = () => {}
  const enteredRpc = new Promise<void>((resolve) => {
    entered = resolve
  })
  const driver: PauseDriver = {
    async pauseOnce({ beforeSend }) {
      if (!beforeSend()) return { acknowledged: false }
      entered()
      if (options.hold) await hold
      return { acknowledged: true }
    },
    async waitForPaused({ binding, after }) {
      const mapping = readPrinterBinding(binding)
      const observed = monotonicNow()
      return {
        assignmentId: mapping?.assignment_id ?? '',
        printerKey: mapping?.printer_key ?? '',
        connectionGeneration: after.connectionGeneration,
        sequence: after.sequence + 1,
        ready: true,
        printState: 'paused',
        readyObservedMono: observed,
        printStateObservedMono: observed,
        receivedMono: observed,
      }
    },
  }
  const phases: unknown[] = []
  const results: unknown[] = []
  const mappings = new Map<string, ReturnType<typeof registry.provision>>()
  const relay = createPauseCommandRelay({
    authority: {
      issuers: [
        { issuer: 'farm:issuer', kid: 'issuer-1', publicKey: issuer.publicKey },
      ],
    },
    clock: { wallNow: Date.now, monotonicNow },
    journal,
    driver,
    bindingFor: (assignmentId) => mappings.get(assignmentId),
  })
  cleanup.push(() => relay.close())
  cleanup.push(() => releaseHold())
  const capabilityId = randomUUID()
  async function makePeer() {
    const transportId = randomUUID()
    const assignmentId = randomUUID()
    const printerKey = `peer-printer-${printerCounter++}`
    const binding = {
      ...baseBinding,
      transport_id: transportId,
      assignment_id: assignmentId,
    }
    const printerBinding = registry.provision({
      assignment_id: assignmentId,
      farm_id: binding.farm_id,
      agent_id: binding.agent_id,
      printer_key: printerKey,
      moonraker_origin: 'https://farm.example',
    })
    mappings.set(assignmentId, printerBinding)
    const browserProofWire = encodeControlProof({
      v: 1,
      role: 'browser',
      binding,
      signature: await signControlSessionProof(
        binding,
        'browser',
        browser.privateKey,
      ),
    })
    const connectorProofWire = encodeControlProof({
      v: 1,
      role: 'connector',
      binding,
      signature: await signControlSessionProof(
        binding,
        'connector',
        connector.privateKey,
      ),
    })
    const bindingHash = await controlBindingHash(binding)
    return {
      transportId,
      assignmentId,
      binding,
      printerBinding,
      printerKey,
      browserProofWire,
      connectorProofWire,
      open(
        input: {
          transport?: boolean
          throwPhase?: boolean
          throwResult?: boolean
        } = {},
      ) {
        if (input.throwPhase)
          return relay.openPeer({
            binding,
            browserProofWire,
            connectorProofWire,
            sendPhase: () => {
              throw new Error('Transport fault')
            },
            sendResult: () => true,
          })
        if (input.throwResult)
          return relay.openPeer({
            binding,
            browserProofWire,
            connectorProofWire,
            sendPhase: (message: unknown) => {
              phases.push(message)
              return true
            },
            sendResult: () => {
              throw new Error('Transport fault')
            },
          })
        return relay.openPeer({
          binding,
          browserProofWire,
          connectorProofWire,
          ...(input.transport === false
            ? {}
            : {
                sendPhase: (message: unknown) => {
                  phases.push(message)
                  return true
                },
                sendResult: (result: unknown) => {
                  results.push(result)
                  return true
                },
              }),
        })
      },
      async issueCapability(admissionNonce: string) {
        const issuedAt = Date.now()
        const capability = await signPauseCapability(
          {
            v: 1,
            purpose: 'pause-authority',
            capability_id: capabilityId,
            kid: 'issuer-1',
            issuer: 'farm:issuer',
            audience: binding.audience,
            origin: binding.origin,
            issued_at: issuedAt,
            expires_at: Math.min(issuedAt + 30000, binding.expires_at),
            account_id: binding.account_id,
            role: 'operator',
            farm_id: binding.farm_id,
            agent_id: binding.agent_id,
            key_id: binding.key_id,
            assignment_id: binding.assignment_id,
            transport_id: binding.transport_id,
            browser_public_key: publicKey,
            browser_thumbprint: thumbprint,
            connector_fingerprint: binding.connector_fingerprint,
            credential_jti: binding.credential_jti,
            printer_key: printerKey,
            control_binding_sha256: bindingHash,
            admission_nonce: admissionNonce,
            actions: ['pause'],
          },
          issuer.privateKey,
        )
        const proof = await signPauseAdmissionProof(
          {
            v: 1,
            purpose: 'pause-admission',
            challenge_id: randomUUID(),
            farm_id: binding.farm_id,
            agent_id: binding.agent_id,
            key_id: binding.key_id,
            assignment_id: binding.assignment_id,
            transport_id: binding.transport_id,
            account_id: binding.account_id,
            browser_thumbprint: thumbprint,
            origin: binding.origin,
            audience: binding.audience,
            control_binding_sha256: bindingHash,
            admission_nonce: admissionNonce,
            issued_at: issuedAt,
            expires_at: issuedAt + 8000,
          },
          browser.privateKey,
        )
        return {
          capabilityWire: encodePauseCapability(capability),
          admissionProofWire: encodePauseAdmissionProof(proof),
        }
      },
      async signedCommand() {
        const issuedAt = Date.now()
        return signCommandV2(
          {
            v: 2,
            purpose: 'printer-pause',
            cmd_id: randomUUID(),
            farm_id: binding.farm_id,
            agent_id: binding.agent_id,
            account_id: binding.account_id,
            key_id: binding.key_id,
            transport_id: binding.transport_id,
            capability_id: capabilityId,
            assignment_id: binding.assignment_id,
            action: 'pause',
            args: {},
            issued_at: issuedAt,
            expires_at: issuedAt + 5000,
            nonce: randomBytes(16).toString('base64url'),
          },
          browser.privateKey,
        )
      },
      publishPrinting() {
        const observed = monotonicNow()
        relay.observe(printerBinding, {
          assignmentId: binding.assignment_id,
          printerKey,
          connectionGeneration: 1,
          sequence: 1,
          ready: true,
          printState: 'printing',
          readyObservedMono: observed,
          printStateObservedMono: observed,
          receivedMono: observed,
        })
      },
    }
  }
  const peer = await makePeer()
  return {
    ...peer,
    journal,
    relay,
    phases,
    results,
    makePeer,
    issuerPublicKey: issuer.publicKey,
    enteredRpc,
  }
}

test('an admitted peer answers its single command with the exact decoded command id', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  assert.equal(f.phases.length, 1)
  const nonce = f.phases[0] as { t: string; admission_nonce: string }
  assert.equal(nonce.t, 'control.admission-nonce')
  const issued = await f.issueCapability(nonce.admission_nonce)
  const admitted = await f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  assert.deepEqual(admitted, { ok: true })
  f.publishPrinting()
  const signed = await f.signedCommand()
  const outcome = await f.relay.commandPeer({
    transportId: f.transportId,
    wire: encodeCommandV2(signed),
  })
  assert.equal(outcome, 'applied')
  assert.equal(f.results.length, 1)
  assert.deepEqual(f.results[0], {
    t: 'control.result',
    command_id: decodeCommandV2(encodeCommandV2(signed)).cmd_id,
    outcome: 'applied',
  })
  assert.equal(readCommandOutcome(f.journal, signed.cmd_id)?.status, 'applied')
  f.relay.close()
  await f.relay.settled
})

test('a command that arrives before the admission settles waits for it', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  const admission = f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.publishPrinting()
  const signed = await f.signedCommand()
  const outcome = await f.relay.commandPeer({
    transportId: f.transportId,
    wire: encodeCommandV2(signed),
  })
  assert.equal(outcome, 'applied')
  assert.deepEqual(await admission, { ok: true })
  assert.equal(f.results.length, 1)
  f.relay.close()
  await f.relay.settled
})

test('the two admission halves arrive separately and the token waits for the pair', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  // Only the capability arrives. The verifier token is not consumed yet.
  const first = f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
  })
  let settled = false
  void first.then(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(f.relay.diagnostics().admitted, 0)
  // The proof completes the exact pair.
  const second = f.relay.admitPeer({
    transportId: f.transportId,
    admissionProofWire: issued.admissionProofWire,
  })
  assert.deepEqual(await second, { ok: true })
  assert.deepEqual(await first, { ok: true })
  assert.equal(f.relay.diagnostics().admitted, 1)
  f.relay.close()
  await f.relay.settled
})

test('a half delivered admission never consumes the token and ends with the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  const attempt = f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
  })
  // The peer deadline ends the wait. No traffic, no admission.
  t.mock.timers.tick(8001)
  assert.deepEqual(await attempt, { ok: false, reason: 'expired-or-inactive' })
  assert.equal(f.relay.diagnostics().admitted, 0)
  assert.equal(f.relay.diagnostics().peers, 0)
})

test('a peer without traffic expires at its own deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  assert.equal(f.relay.diagnostics().peers, 1)
  t.mock.timers.tick(8001)
  assert.equal(f.relay.diagnostics().peers, 0)
  assert.equal(f.relay.diagnostics().expired, 1)
})

test('a second command of the same peer replays the first outcome', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.publishPrinting()
  const signed = await f.signedCommand()
  const wire = encodeCommandV2(signed)
  const first = await f.relay.commandPeer({
    transportId: f.transportId,
    wire,
  })
  const second = await f.relay.commandPeer({
    transportId: f.transportId,
    wire,
  })
  assert.equal(first, 'applied')
  assert.equal(second, 'applied')
  assert.equal(f.results.length, 1)
  assert.equal(f.relay.diagnostics().commands, 1)
  f.relay.close()
  await f.relay.settled
})

test('a peer without a local mapping is refused and never receives a nonce', async (t) => {
  const f = await relayFixture(t)
  const refused = createPauseCommandRelay({
    authority: {
      issuers: [
        {
          issuer: 'farm:issuer',
          kid: 'issuer-1',
          publicKey: f.issuerPublicKey,
        },
      ],
    },
    clock: { wallNow: Date.now, monotonicNow: () => Date.now() },
    journal: f.journal,
    driver: {
      pauseOnce: async () => ({ acknowledged: false }),
      waitForPaused: async () => null,
    },
    bindingFor: () => undefined,
  })
  t.after(() => refused.close())
  assert.equal(
    refused.openPeer({
      binding: f.binding,
      browserProofWire: f.browserProofWire,
      connectorProofWire: f.connectorProofWire,
      sendPhase: () => true,
      sendResult: () => true,
    }),
    false,
  )
  assert.equal(refused.diagnostics().peers, 0)
})

test('a peer without a transport stays inert and is closed again', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open({ transport: false }), false)
  assert.equal(f.phases.length, 0)
  assert.equal(f.relay.diagnostics().peers, 0)
})

test('a throwing transport callback never leaks a peer', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open({ throwPhase: true }), false)
  assert.equal(f.relay.diagnostics().peers, 0)
  assert.equal(f.relay.diagnostics().admitted, 0)
})

test('an unverified peer never replaces a live peer', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  // A peer whose proofs do not match its binding is refused before it can
  // replace the live peer of the same transport id.
  assert.equal(
    f.relay.openPeer({
      binding: f.binding,
      browserProofWire: f.connectorProofWire,
      connectorProofWire: f.browserProofWire,
      sendPhase: () => true,
      sendResult: () => true,
    }),
    false,
  )
  assert.equal(f.relay.diagnostics().peers, 1)
  assert.equal(f.relay.diagnostics().admitted, 1)
  f.relay.close()
  await f.relay.settled
})

test('a late admission after the close never resurrects the peer', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  const attempt = f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
  })
  f.relay.closePeer(f.transportId)
  assert.equal(f.relay.diagnostics().peers, 0)
  // The proof arrives after the peer was sealed.
  const late = f.relay.admitPeer({
    transportId: f.transportId,
    admissionProofWire: issued.admissionProofWire,
  })
  assert.deepEqual(await attempt, { ok: false, reason: 'expired-or-inactive' })
  assert.deepEqual(await late, { ok: false, reason: 'unknown-peer' })
  assert.equal(f.relay.diagnostics().admitted, 0)
  assert.equal(f.relay.diagnostics().peers, 0)
  f.relay.close()
  await f.relay.settled
})

test('a throwing result callback keeps the outcome local', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open({ throwResult: true }), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.publishPrinting()
  const signed = await f.signedCommand()
  // The transport faults on the result frame. The outcome stays local and the
  // caller still receives it instead of a rejected promise.
  const outcome = await f.relay.commandPeer({
    transportId: f.transportId,
    wire: encodeCommandV2(signed),
  })
  assert.equal(outcome, 'applied')
  assert.equal(f.relay.diagnostics().unsentResults, 1)
  assert.equal(f.relay.diagnostics().applied, 1)
  f.relay.close()
  await f.relay.settled
})

test('closing a peer revokes the capability and seals every later send', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.relay.closePeer(f.transportId)
  assert.equal(f.relay.diagnostics().peers, 0)
  f.publishPrinting()
  const signed = await f.signedCommand()
  const outcome = await f.relay.commandPeer({
    transportId: f.transportId,
    wire: encodeCommandV2(signed),
  })
  assert.equal(outcome, 'rejected')
  assert.equal(f.results.length, 0)
  assert.equal(readCommandOutcome(f.journal, signed.cmd_id), null)
})

test('closing the relay stops every command', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  f.relay.close()
  assert.equal(f.relay.diagnostics().closed, true)
  const signed = await f.signedCommand()
  const outcome = await f.relay.commandPeer({
    transportId: f.transportId,
    wire: encodeCommandV2(signed),
  })
  assert.equal(outcome, 'rejected')
  assert.equal(f.results.length, 0)
  await f.relay.settled
})

test('aborting an in-flight dispatch settles as unknown and never sends a late result', async (t) => {
  const f = await relayFixture(t, { hold: true })
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: f.transportId,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.publishPrinting()
  const signed = await f.signedCommand()
  const outcome = f.relay.commandPeer({
    transportId: f.transportId,
    wire: encodeCommandV2(signed),
  })
  await f.enteredRpc
  f.relay.closePeer(f.transportId)
  assert.equal(await outcome, 'outcome-unknown')
  assert.equal(f.results.length, 0)
  assert.equal(
    readCommandOutcome(f.journal, signed.cmd_id)?.status,
    'outcome-unknown',
  )
  f.relay.close()
  await f.relay.settled
})

test('the peer map is bounded and a peer beyond the cap is refused', async (t) => {
  const f = await relayFixture(t)
  for (let index = 0; index < PAUSE_RELAY_MAX_PEERS; index++) {
    const peer = await f.makePeer()
    assert.equal(peer.open(), true)
  }
  assert.equal(f.relay.diagnostics().peers, PAUSE_RELAY_MAX_PEERS)
  const extra = await f.makePeer()
  assert.equal(extra.open(), false)
  assert.equal(f.relay.diagnostics().peers, PAUSE_RELAY_MAX_PEERS)
  f.relay.close()
  await f.relay.settled
})

test('the concurrent command bound refuses a command beyond the cap', async (t) => {
  const f = await relayFixture(t, { hold: true })
  const peers = []
  for (let index = 0; index < PAUSE_RELAY_MAX_COMMANDS; index++) {
    const peer = await f.makePeer()
    assert.equal(peer.open(), true)
    const nonce = f.phases[f.phases.length - 1] as { admission_nonce: string }
    const issued = await peer.issueCapability(nonce.admission_nonce)
    assert.deepEqual(
      await f.relay.admitPeer({
        transportId: peer.transportId,
        capabilityWire: issued.capabilityWire,
        admissionProofWire: issued.admissionProofWire,
      }),
      { ok: true },
    )
    peer.publishPrinting()
    const signed = await peer.signedCommand()
    peers.push({
      peer,
      outcome: f.relay.commandPeer({
        transportId: peer.transportId,
        wire: encodeCommandV2(signed),
      }),
    })
  }
  await f.enteredRpc
  const extra = await f.makePeer()
  assert.equal(extra.open(), true)
  const nonce = f.phases[f.phases.length - 1] as { admission_nonce: string }
  const issued = await extra.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: extra.transportId,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  extra.publishPrinting()
  const signed = await extra.signedCommand()
  // The command beyond the bound is refused, never queued.
  assert.equal(
    await f.relay.commandPeer({
      transportId: extra.transportId,
      wire: encodeCommandV2(signed),
    }),
    'rejected',
  )
  assert.equal(f.relay.diagnostics().lastReason, 'busy')
  f.relay.close()
  await f.relay.settled
})

/**
 * The real control transport on both sides, in memory, with real keys, a
 * real SQLite journal and a local driver double. No network, no RTC peer and
 * no printer are involved.
 */
async function transportFixture(t: test.TestContext) {
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  t.after(async () => {
    for (const dispose of cleanup.reverse()) await dispose()
  })
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connectorKeys = generateKeyPairSync('ed25519')
  const identity = new ConnectorIdentity(connectorKeys.privateKey)
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const now = Date.now()
  const transportId = randomUUID()
  const farmId = randomUUID()
  const agentId = randomUUID()
  const assignmentId = randomUUID()
  const printerKey = 'transport-printer-key'
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: transportId,
    farm_id: farmId,
    agent_id: agentId,
    account_id: 'legacy_account',
    key_id: randomUUID(),
    assignment_id: assignmentId,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const bindingHash = await controlBindingHash(binding)
  const registry = createPrinterBindingRegistry({
    allowedOrigins: ['https://farm.example'],
  })
  const printerBinding = registry.provision({
    assignment_id: assignmentId,
    farm_id: farmId,
    agent_id: agentId,
    printer_key: printerKey,
    moonraker_origin: 'https://farm.example',
  })
  const directory = mkdtempSync(join(tmpdir(), 'pause-command-transport-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  const driver: PauseDriver = {
    async pauseOnce({ beforeSend }) {
      if (!beforeSend()) return { acknowledged: false }
      return { acknowledged: true }
    },
    async waitForPaused({ binding: peerBinding, after }) {
      const mapping = readPrinterBinding(peerBinding)
      const observed = performance.now()
      return {
        assignmentId: mapping?.assignment_id ?? '',
        printerKey: mapping?.printer_key ?? '',
        connectionGeneration: after.connectionGeneration,
        sequence: after.sequence + 1,
        ready: true,
        printState: 'paused',
        readyObservedMono: observed,
        printStateObservedMono: observed,
        receivedMono: observed,
      }
    },
  }
  const relay = createPauseCommandRelay({
    authority: {
      issuers: [
        { issuer: 'farm:issuer', kid: 'issuer-1', publicKey: issuer.publicKey },
      ],
    },
    clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
    journal,
    driver,
    bindingFor: (id) => (id === assignmentId ? printerBinding : undefined),
  })
  cleanup.push(() => relay.close())
  const aborted = new AbortController()
  let nonce = ''
  let browserSession!: PauseControlSession
  const client = createPauseCommandClient({
    privateKey: browser.privateKey,
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    transport: {
      sendPhase: (message) => browserSession.sendPhase(message),
      sendCommand: (message) => browserSession.sendCommand(message),
    },
    issuer: {
      async challenge({ admissionNonce }) {
        nonce = admissionNonce
        return {
          v: 1 as const,
          purpose: 'pause-admission' as const,
          challenge_id: randomUUID(),
          farm_id: binding.farm_id,
          agent_id: binding.agent_id,
          key_id: binding.key_id,
          assignment_id: binding.assignment_id,
          transport_id: binding.transport_id,
          account_id: binding.account_id,
          browser_thumbprint: thumbprint,
          origin: binding.origin,
          audience: binding.audience,
          control_binding_sha256: bindingHash,
          admission_nonce: admissionNonce,
          issued_at: Date.now(),
          expires_at: Date.now() + 8000,
        }
      },
      async capability() {
        const issuedAt = Date.now()
        return signPauseCapability(
          {
            v: 1,
            purpose: 'pause-authority',
            capability_id: randomUUID(),
            kid: 'issuer-1',
            issuer: 'farm:issuer',
            audience: binding.audience,
            origin: binding.origin,
            issued_at: issuedAt,
            expires_at: Math.min(issuedAt + 30000, binding.expires_at),
            account_id: binding.account_id,
            role: 'operator',
            farm_id: binding.farm_id,
            agent_id: binding.agent_id,
            key_id: binding.key_id,
            assignment_id: binding.assignment_id,
            transport_id: binding.transport_id,
            browser_public_key: publicKey,
            browser_thumbprint: thumbprint,
            connector_fingerprint: binding.connector_fingerprint,
            credential_jti: binding.credential_jti,
            printer_key: printerKey,
            control_binding_sha256: bindingHash,
            admission_nonce: nonce,
            actions: ['pause'],
          },
          issuer.privateKey,
        )
      },
    },
  })
  const expected = {
    transportId,
    farmId,
    agentId,
    assignmentId,
    accountId: binding.account_id,
    keyId: binding.key_id,
    origin: binding.origin,
    audience: binding.audience,
  }
  const connectorSession = new PauseControlSession({
    role: 'connector',
    identity,
    expected,
    send: (wire) => {
      browserSession.receive(wire)
    },
    onProofsReady: (ready) => {
      relay.openPeer({
        binding: ready.binding,
        browserProofWire: ready.browserProofWire,
        connectorProofWire: ready.connectorProofWire,
        sendPhase: (message) => connectorSession.sendPhase(message),
        sendResult: (message) => connectorSession.sendResult(message),
        signal: aborted.signal,
      })
    },
    onPhase: (frame) => {
      if (frame.t === 'control.capability')
        void relay.admitPeer({
          transportId,
          capabilityWire: frame.wire,
        })
      else if (frame.t === 'control.admission-proof')
        void relay.admitPeer({
          transportId,
          admissionProofWire: frame.wire,
        })
    },
    onData: (frame) => {
      if (frame.t === 'control.command')
        void relay.commandPeer({ transportId, wire: frame.wire })
    },
    onTerminal: () => {
      aborted.abort()
    },
  })
  browserSession = new PauseControlSession({
    role: 'browser',
    privateKey: browser.privateKey,
    expected,
    send: (wire) => {
      connectorSession.receive(wire)
    },
    onProofsReady: (ready) => {
      client.proofsReady(ready)
    },
    onPhase: (frame) => {
      client.phase(frame)
    },
    onData: (frame) => {
      client.data(frame)
    },
    onTerminal: () => {
      client.abort()
    },
  })
  cleanup.push(() => browserSession.close('closed'))
  cleanup.push(() => connectorSession.close('closed'))
  await connectorSession.activate(binding)
  await browserSession.activate(binding)
  return {
    binding,
    relay,
    client,
    journal,
    printerBinding,
    publishPrinting() {
      const observed = performance.now()
      relay.observe(printerBinding, {
        assignmentId,
        printerKey,
        connectionGeneration: 1,
        sequence: 1,
        ready: true,
        printState: 'printing',
        readyObservedMono: observed,
        printStateObservedMono: observed,
        receivedMono: observed,
      })
    },
  }
}

test('the real control transport carries the two admission frames, the command and the result', async (t) => {
  const f = await transportFixture(t)
  await waitFor(() => f.client.state.admitted)
  assert.equal(f.relay.diagnostics().peers, 1)
  f.publishPrinting()
  // The command is sent right after the admission phases. The relay admits
  // the peer while the command is already on the wire.
  const outcome = f.client.pause()
  assert.equal(await outcome, 'applied')
  assert.equal(f.relay.diagnostics().admitted, 1)
  assert.equal(f.relay.diagnostics().commands, 1)
  assert.equal(f.relay.diagnostics().applied, 1)
  f.relay.close()
  await f.relay.settled
})

for (const field of ['capabilityWire', 'admissionProofWire'] as const) {
  test(`oversized partial ${field} is rejected before retention`, async (t) => {
    const f = await relayFixture(t)
    assert.equal(f.open(), true)
    const result = await f.relay.admitPeer({
      transportId: f.transportId,
      [field]: 'x'.repeat(8193),
    })
    assert.deepEqual(result, { ok: false, reason: 'invalid-proof' })
    assert.equal(f.relay.diagnostics().peers, 0)
    assert.equal(f.relay.diagnostics().admitted, 0)
    f.relay.close()
    await f.relay.settled
  })
}
