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
import type { PreparedPauseDriver } from '../../packages/connector/src/control/pause-dispatcher.ts'
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

import { openTrustedKeyStore } from '../../packages/connector/src/auth/trusted-key-store.ts'
import {
  signTrustedKeySet,
  encodeTrustedKeySetFrame,
} from '../../packages/farm-protocol/src/trusted-keys.ts'

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
  options: { hold?: boolean; wallNow?: () => number } = {},
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
  const driver: PreparedPauseDriver = {
    prepare: async ({ binding }) => {
      const mapping = readPrinterBinding(binding)
      const now = performance.now()
      if (mapping)
        relay.observe(binding, {
          assignmentId: mapping.assignment_id,
          printerKey: mapping.printer_key,
          connectionGeneration: 1,
          sequence: 1,
          ready: true,
          printState: 'printing',
          readyObservedMono: now,
          printStateObservedMono: now,
          receivedMono: now,
        })
      return { connectionGeneration: 1 }
    },
    closeAttempt: async () => {},
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
  const store = await openTrustedKeyStore({
    path: join(directory, 'keys.json'),
    farmId,
    issuers: [
      { issuer: 'farm:issuer', kid: 'issuer-1', publicKey: issuer.publicKey },
    ],
  })
  async function confirm(version: number, listed: boolean) {
    const keySet = await signTrustedKeySet(
      {
        v: 1,
        purpose: 'trusted-key-set',
        farm_id: farmId,
        version,
        issued_at: Date.now(),
        issuer: 'farm:issuer',
        kid: 'issuer-1',
        issuer_keys: [
          {
            issuer: 'farm:issuer',
            kid: 'issuer-1',
            public_key_spki: Buffer.from(
              await crypto.subtle.exportKey('spki', issuer.publicKey),
            ).toString('base64url'),
          },
        ],
        browser_keys: listed
          ? [
              {
                key_id: keyId,
                account_id: baseBinding.account_id,
                thumbprint,
                public_key: publicKey,
              },
            ]
          : [],
      },
      issuer.privateKey,
    )
    assert.equal(
      await store.confirm(
        encodeTrustedKeySetFrame({
          v: 1,
          t: 'trusted-keys.set',
          key_set: keySet,
        }),
      ),
      true,
    )
  }
  const relay = createPauseCommandRelay({
    authority: {
      // Always-fresh stub: these tests exercise relay behavior, not offline lifetime.
      freshness: { freshAt: () => true },
      trustedKeys: store.authority,
      issuers: [
        { issuer: 'farm:issuer', kid: 'issuer-1', publicKey: issuer.publicKey },
      ],
    },
    clock: { wallNow: options.wallNow ?? Date.now, monotonicNow },
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
    confirm,
    journal,
    relay,
    phases,
    results,
    makePeer,
    issuerPublicKey: issuer.publicKey,
    enteredRpc,
    releaseHold,
  }
}

test('signed trusted keys permit listed browsers and revoke existing and new commands', async (t) => {
  const f = await relayFixture(t)
  await f.confirm(1, true)
  assert.equal(f.open(), true)
  const nonce = f.phases[0] as { admission_nonce: string }
  const issued = await f.issueCapability(nonce.admission_nonce)
  assert.deepEqual(
    await f.relay.admitPeer({ transportId: f.transportId, ...issued }),
    { ok: true },
  )
  f.publishPrinting()
  assert.equal(
    await f.relay.commandPeer({
      transportId: f.transportId,
      wire: encodeCommandV2(await f.signedCommand()),
    }),
    'applied',
  )
  const revokedPeer = await f.makePeer()
  assert.equal(revokedPeer.open(), true)
  const revokedNonce = f.phases.at(-1) as { admission_nonce: string }
  const revokedIssued = await revokedPeer.issueCapability(
    revokedNonce.admission_nonce,
  )
  assert.deepEqual(
    await f.relay.admitPeer({
      transportId: revokedPeer.transportId,
      ...revokedIssued,
    }),
    { ok: true },
  )
  await f.confirm(2, false)
  const result = await f.relay.commandPeer({
    transportId: revokedPeer.transportId,
    wire: encodeCommandV2(await revokedPeer.signedCommand()),
  })
  assert.equal(result, 'rejected')
  assert.ok(f.relay.diagnostics().lastReason)
  const next = await f.makePeer()
  assert.equal(next.open(), true)
  const nextNonce = f.phases.at(-1) as { admission_nonce: string }
  const nextIssued = await next.issueCapability(nextNonce.admission_nonce)
  const denied = await f.relay.admitPeer({
    transportId: next.transportId,
    ...nextIssued,
  })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.ok(denied.reason)
  f.relay.close()
  await f.relay.settled
})
