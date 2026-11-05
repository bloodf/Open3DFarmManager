import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openCommandJournal,
  closeCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseCommandRelay } from '../../packages/connector/src/control/pause-command-relay.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
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

const digest = () => randomBytes(32).toString('base64url')

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
  const transportId = randomUUID()
  const capabilityId = randomUUID()
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: transportId,
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
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
  const printerKey = 'é"\\'.repeat(32)
  const registry = createPrinterBindingRegistry({
    allowedOrigins: ['https://farm.example'],
  })
  const printerBinding = registry.provision({
    assignment_id: binding.assignment_id,
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    printer_key: printerKey,
    moonraker_origin: 'https://farm.example',
  })
  const directory = mkdtempSync(join(tmpdir(), 'pause-command-relay-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  let mono = 1_000_000
  const monotonicNow = () => (mono += 1)
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
    async waitForPaused() {
      const observed = monotonicNow()
      return {
        assignmentId: binding.assignment_id,
        printerKey,
        connectionGeneration: 1,
        sequence: 2,
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
  const relay = createPauseCommandRelay({
    authority: {
      issuers: [
        { issuer: 'farm:issuer', kid: 'issuer-1', publicKey: issuer.publicKey },
      ],
    },
    clock: { wallNow: Date.now, monotonicNow },
    journal,
    driver,
    bindingFor: (assignmentId) =>
      assignmentId === binding.assignment_id ? printerBinding : undefined,
  })
  cleanup.push(() => relay.close())
  cleanup.push(() => releaseHold())
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
  function publishPrinting(): void {
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
  }
  async function issueCapability(admissionNonce: string) {
    const bindingHash = await controlBindingHash(binding)
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
  }
  async function signedCommand() {
    const issuedAt = Date.now()
    const signed = await signCommandV2(
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
    return signed
  }
  return {
    binding,
    printerBinding,
    journal,
    relay,
    phases,
    results,
    publishPrinting,
    issueCapability,
    signedCommand,
    issuerPublicKey: issuer.publicKey,
    open(input: { transport?: boolean } = {}) {
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
    transportId: f.binding.transport_id,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  assert.deepEqual(admitted, { ok: true })
  f.publishPrinting()
  const signed = await f.signedCommand()
  const outcome = await f.relay.commandPeer({
    transportId: f.binding.transport_id,
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
  await f.relay.settled
})

test('a command that arrives before the admission settles waits for it', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  const admission = f.relay.admitPeer({
    transportId: f.binding.transport_id,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.publishPrinting()
  const signed = await f.signedCommand()
  const outcome = await f.relay.commandPeer({
    transportId: f.binding.transport_id,
    wire: encodeCommandV2(signed),
  })
  assert.equal(outcome, 'applied')
  assert.deepEqual(await admission, { ok: true })
  assert.equal(f.results.length, 1)
  await f.relay.settled
})

test('a second command of the same peer replays the first outcome', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: f.binding.transport_id,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.publishPrinting()
  const signed = await f.signedCommand()
  const wire = encodeCommandV2(signed)
  const first = await f.relay.commandPeer({
    transportId: f.binding.transport_id,
    wire,
  })
  const second = await f.relay.commandPeer({
    transportId: f.binding.transport_id,
    wire,
  })
  assert.equal(first, 'applied')
  assert.equal(second, 'applied')
  assert.equal(f.results.length, 1)
  assert.equal(f.relay.diagnostics().commands, 1)
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
    clock: { wallNow: Date.now, monotonicNow: () => 1_000_001 },
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
      browserProofWire: 'x',
      connectorProofWire: 'y',
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

test('closing a peer revokes the capability and seals every later send', async (t) => {
  const f = await relayFixture(t)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: f.binding.transport_id,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.relay.closePeer(f.binding.transport_id)
  assert.equal(f.relay.diagnostics().peers, 0)
  f.publishPrinting()
  const signed = await f.signedCommand()
  const outcome = await f.relay.commandPeer({
    transportId: f.binding.transport_id,
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
    transportId: f.binding.transport_id,
    wire: encodeCommandV2(signed),
  })
  assert.equal(outcome, 'rejected')
  assert.equal(f.results.length, 0)
})

test('aborting an in-flight dispatch settles as unknown and never sends a late result', async (t) => {
  const f = await relayFixture(t, { hold: true })
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  await f.relay.admitPeer({
    transportId: f.binding.transport_id,
    capabilityWire: issued.capabilityWire,
    admissionProofWire: issued.admissionProofWire,
  })
  f.publishPrinting()
  const signed = await f.signedCommand()
  const outcome = f.relay.commandPeer({
    transportId: f.binding.transport_id,
    wire: encodeCommandV2(signed),
  })
  await f.enteredRpc
  f.relay.closePeer(f.binding.transport_id)
  assert.equal(await outcome, 'outcome-unknown')
  assert.equal(f.results.length, 0)
  assert.equal(
    readCommandOutcome(f.journal, signed.cmd_id)?.status,
    'outcome-unknown',
  )
  await f.relay.settled
})
