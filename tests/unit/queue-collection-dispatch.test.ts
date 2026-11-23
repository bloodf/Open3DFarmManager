import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { withCollectionHold } from '../../packages/connector/src/control/queue-collection-hold.ts'
import { openQueueCollectionJournal } from '../../packages/connector/src/control/queue-collection-journal.ts'
import type { WebSocket } from 'ws'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  encodeCommandV2,
  signCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'

// Loopback fixture only (127.0.0.1, port 0). The authority, capability and
// command are synthetic; nothing here reaches a physical printer.
const LIMITS = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 2000,
  requestTimeoutMs: 2000,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
let lastMono = 0
const monotonicNow = () =>
  (lastMono = Math.max(performance.now(), lastMono + 0.001))
const OBJECTS = ['extruder', 'extruder1', 'heater_bed']

type Printer = {
  /** Moonraker print_stats.state reported by the fixture. */
  state: 'standby' | 'printing' | 'paused'
  /** Klipper can_extrude: temperature at or above min_extrude_temp. */
  canExtrude?: boolean | 'malformed'
  objects?: readonly string[]
}

const reply = (socket: WebSocket, id: number, result: unknown) =>
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))

async function world(t: TestContext, printer: Printer) {
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  t.onTestFinished(async () => {
    for (const dispose of cleanup.reverse()) await dispose()
  })
  const now = Date.now()
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { publicKey } = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const { thumbprint } = await validateBrowserDevicePublicKey(publicKey)
  const ids = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const account_id = 'legacy_account'
  const printer_key = 'printer-extrude'
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: ids.transport_id,
    farm_id: ids.farm_id,
    agent_id: ids.agent_id,
    account_id,
    key_id: ids.key_id,
    assignment_id: ids.assignment_id,
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
  const { controlBindingHash } =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const bindingHash = await controlBindingHash(binding)

  const directory = mkdtempSync(join(tmpdir(), 'control-extrude-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  // Query 1 is the prepare read, 2 the extrusion probe, 3 the result audit.
  let configReads = 0
  const remote = await pauseFixture({
    objects: printer.objects ?? OBJECTS,
    query: (rawIndex, socket, id) => {
      // Detection also reads the macro config when any macro is advertised.
      const asked = remote.requests.at(-1)?.params as
        { objects?: Record<string, unknown> } | undefined
      if (asked?.objects && 'configfile' in asked.objects) {
        configReads++
        reply(socket, id, { eventtime: rawIndex, status: {} })
        return true
      }
      const index = rawIndex - configReads
      if (index === 2)
        reply(
          socket,
          id,
          printer.canExtrude === 'malformed'
            ? { status: {} }
            : {
                eventtime: index,
                status: Object.fromEntries(
                  ['extruder', 'extruder1'].map((name) => [
                    name,
                    {
                      temperature: printer.canExtrude === false ? 20 : 210,
                      can_extrude: printer.canExtrude !== false,
                    },
                  ]),
                ),
              },
        )
      else
        reply(socket, id, {
          eventtime: index,
          status: {
            webhooks: { state: 'ready' },
            print_stats: { state: printer.state },
          },
        })
      return true
    },
  })
  cleanup.push(() => remote.close())
  const printerBinding = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  }).provision({
    assignment_id: ids.assignment_id,
    farm_id: ids.farm_id,
    agent_id: ids.agent_id,
    printer_key,
    moonraker_origin: remote.origin,
  })
  let dispatcher: ReturnType<typeof createPauseDispatcher> | undefined
  const router = createPauseDriverRouter({
    allowedOrigins: [remote.origin],
    limits: LIMITS,
    clock: { monotonicNow },
    observe: (target, observation) =>
      dispatcher?.observe(target, observation) ?? false,
  })
  cleanup.push(() => router.closeAttempt(printerBinding))
  await router.detect(printerBinding)
  const collection = openQueueCollectionJournal(
    join(directory, 'collection.json'),
  )
  collection.complete(printer_key, '5000')
  dispatcher = createPauseDispatcher({
    authority: {
      issuers: [
        { issuer: 'farm:issuer', kid: 'issuer-1', publicKey: issuer.publicKey },
      ],
    },
    clock: { wallNow: () => Date.now(), monotonicNow },
    journal,
    driver: withCollectionHold(router, {
      journal: collection,
      printerKey: () => printer_key,
      clock: Date.now,
    }),
    resultTimeoutMs: 5000,
  })
  const active = dispatcher
  cleanup.push(() => active.close())
  const controls =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const caps =
    await import('../../packages/farm-protocol/src/pause-capability.ts')
  const admission = active.beginAdmission({
    binding,
    printerBinding,
    peer: active.createPeer(1).peer,
  })
  const admissionNonce = admission.challenge.admissionNonce
  const admittedAt = Date.now()
  const capability = await caps.signPauseCapability(
    {
      v: 1 as const,
      purpose: 'pause-authority' as const,
      capability_id: ids.capability_id,
      kid: 'issuer-1',
      issuer: 'farm:issuer',
      audience: binding.audience,
      origin: binding.origin,
      issued_at: admittedAt,
      expires_at: binding.expires_at,
      account_id,
      role: 'operator' as const,
      farm_id: ids.farm_id,
      agent_id: ids.agent_id,
      key_id: ids.key_id,
      assignment_id: ids.assignment_id,
      transport_id: ids.transport_id,
      browser_public_key: publicKey,
      browser_thumbprint: thumbprint,
      connector_fingerprint: binding.connector_fingerprint,
      credential_jti: binding.credential_jti,
      printer_key,
      control_binding_sha256: bindingHash,
      admission_nonce: admissionNonce,
      actions: ['confirm_collection'],
    },
    issuer.privateKey,
  )
  const proof = await caps.signPauseAdmissionProof(
    {
      v: 1 as const,
      purpose: 'pause-admission' as const,
      challenge_id: randomUUID(),
      farm_id: ids.farm_id,
      agent_id: ids.agent_id,
      key_id: ids.key_id,
      assignment_id: ids.assignment_id,
      transport_id: ids.transport_id,
      account_id,
      browser_thumbprint: thumbprint,
      origin: binding.origin,
      audience: binding.audience,
      control_binding_sha256: bindingHash,
      admission_nonce: admissionNonce,
      issued_at: admittedAt,
      expires_at: admittedAt + 8000,
    },
    pair.privateKey,
  )
  const proofOf = async (role: 'browser' | 'connector', key: CryptoKey) =>
    controls.encodeControlProof({
      v: 1,
      role,
      binding,
      signature: await controls.signControlSessionProof(binding, role, key),
    })
  const accepted = await active.admit(admission.token, {
    capabilityWire: caps.encodePauseCapability(capability),
    admissionProofWire: caps.encodePauseAdmissionProof(proof),
    browserProofWire: await proofOf('browser', pair.privateKey),
    connectorProofWire: await proofOf('connector', connector.privateKey),
  })
  if (!accepted.ok) throw new Error(`not admitted: ${accepted.reason}`)
  const issuedAt = Date.now()
  const signed = await signCommandV2(
    {
      v: 2 as const,
      purpose: 'printer-control' as const,
      cmd_id: randomUUID(),
      ...ids,
      account_id,
      action: 'confirm_collection',
      args: { attempt: '5000' },
      issued_at: issuedAt,
      expires_at: issuedAt + 5000,
      nonce: randomBytes(16).toString('base64url'),
    },
    pair.privateKey,
  )
  return {
    remote,
    collection,
    dispatch: () =>
      active.dispatch({
        wire: encodeCommandV2(signed),
        capability: accepted.handle,
        printerBinding,
      }),
    methods: () => remote.requests.map(({ method }) => method),
  }
}

it('acknowledges a local collection confirmation and releases the hold', async (t) => {
  const f = await world(t, { state: 'standby' })
  expect(f.collection.blocked('printer-extrude')).toBe(true)
  expect(await f.dispatch()).toMatchObject({
    kind: 'applied',
    reason: 'applied',
  })
  expect(f.collection.blocked('printer-extrude')).toBe(false)
})
