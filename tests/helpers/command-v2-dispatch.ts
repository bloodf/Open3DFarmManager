// Shipped v2 command path for tests: capability admission, signature
// verification (verifyCommandV2) and the durable command journal, wired through
// the real pause dispatcher. The default driver is a fake. Tests can supply a
// loopback simulator and the real driver.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  createPauseDispatcher,
  type ControlObservation,
  type PauseDispatchResult,
  type PreparedPauseDriver,
} from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  createPrinterBindingRegistry,
  readPrinterBinding,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import {
  encodeCommandV2,
  signCommandV2,
  type SignedCommandV2,
  type UnsignedCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
  type ControlSessionBinding,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodePauseAdmissionProof,
  encodePauseCapability,
  signPauseAdmissionProof,
  signPauseCapability,
  type PauseAdmissionChallenge,
  type PauseAdmissionProof,
  type PauseCapabilityV1,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'

/** The browser device key. In e2e tests it lives inside Chromium. */
export interface V2Signer {
  publicJwk: { kty: string; crv: string; x: string; y: string }
  signCommand(input: UnsignedCommandV2): Promise<SignedCommandV2>
  signAdmissionProof(
    challenge: PauseAdmissionChallenge,
  ): Promise<PauseAdmissionProof>
  signControlProof(binding: ControlSessionBinding): Promise<string>
}

export async function nodeSigner(): Promise<V2Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  return {
    publicJwk: { kty: kty!, crv: crv!, x: x!, y: y! },
    signCommand: (input) => signCommandV2(input, pair.privateKey),
    signAdmissionProof: (challenge) =>
      signPauseAdmissionProof(challenge, pair.privateKey),
    signControlProof: (binding) =>
      signControlSessionProof(binding, 'browser', pair.privateKey),
  }
}

const digest = () => randomBytes(32).toString('base64url')

/** Stable identities and issuer/connector keys, so a journal can be reopened. */
export async function createV2Authority(signer: V2Signer) {
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey(
    signer.publicJwk,
  )
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
  const ids = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'account_1',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const binding: ControlSessionBinding = {
    v: 1,
    purpose: 'pause-rtc',
    transport_id: ids.transport_id,
    farm_id: ids.farm_id,
    agent_id: ids.agent_id,
    account_id: ids.account_id,
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
    issued_at: 1000,
    expires_at: 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  } as ControlSessionBinding
  return {
    signer,
    ids,
    issuer,
    connector,
    binding,
    publicKey,
    thumbprint,
    printerKey: 'printer-1',
    /** A fresh, unsigned command in this authority's scope. */
    command(
      overrides: Partial<UnsignedCommandV2> = {},
      issuedAt = 1000,
    ): UnsignedCommandV2 {
      return {
        v: 2,
        purpose: 'printer-pause',
        cmd_id: randomUUID(),
        ...ids,
        action: 'pause',
        args: {},
        issued_at: issuedAt,
        expires_at: issuedAt + 5000,
        nonce: randomBytes(16).toString('base64url'),
        ...overrides,
      } as UnsignedCommandV2
    },
    async sign(
      overrides: Partial<UnsignedCommandV2> = {},
      issuedAt = 1000,
    ): Promise<string> {
      return encodeCommandV2(
        await signer.signCommand(this.command(overrides, issuedAt)),
      )
    },
  }
}
export type V2Authority = Awaited<ReturnType<typeof createV2Authority>>

export type V2DispatchOptions = {
  /** Reuse a journal directory across reopen; caller owns its removal. */
  directory?: string
  /** Wall and monotonic start time. */
  now?: number
  capability?: Partial<PauseCapabilityV1>
  /** Override the wire to model a different issuer version. */
  capabilityWire?: (
    claims: PauseCapabilityV1,
    key: CryptoKey,
  ) => Promise<string>
  journalCapacity?: number
  storageDegraded?: () => boolean
  /** Extra actions the fake driver supports (through `execute`). */
  controls?: ExtendedControlAction[]
  loopback?: {
    origin: string
    driver(input: {
      clock: { monotonicNow(): number }
      observe(
        binding: PrinterBinding,
        observation: ControlObservation | null,
      ): boolean
    }): PreparedPauseDriver & {
      detect(binding: PrinterBinding): Promise<unknown>
    }
  }
}

/** Opens the shipped dispatcher with an admitted capability for `authority`. */
export async function openV2Dispatch(
  authority: V2Authority,
  options: V2DispatchOptions = {},
) {
  const owned = options.directory === undefined
  const directory =
    options.directory ?? mkdtempSync(join(tmpdir(), 'open3d-command-v2-'))
  let wall = options.now ?? 1000
  let mono = wall
  const start = performance.now()
  const elapsed = () => (options.loopback ? performance.now() - start : 0)
  const clock = {
    wallNow: () => wall + Math.floor(elapsed()),
    monotonicNow: () => mono + elapsed(),
  }
  let journalWall: number | undefined
  let writes = 0
  let driverEntries = 0
  const journal = openCommandJournal({
    directory,
    clock: () => journalWall ?? clock.wallNow(),
    ...(options.journalCapacity ? { capacity: options.journalCapacity } : {}),
  })
  const origin = options.loopback?.origin ?? 'http://localhost:7125'
  const bindings = createPrinterBindingRegistry({
    allowedOrigins: [origin],
  })
  const printerBinding = bindings.provision({
    assignment_id: authority.ids.assignment_id,
    farm_id: authority.ids.farm_id,
    agent_id: authority.ids.agent_id,
    printer_key: authority.printerKey,
    moonraker_origin: origin,
  })
  let sequence = 1
  const observation = () => ({
    assignmentId: authority.ids.assignment_id,
    printerKey: authority.printerKey,
    connectionGeneration: 1,
    sequence,
    ready: true,
    printState: 'printing' as const,
    readyObservedMono: mono,
    printStateObservedMono: mono,
    receivedMono: mono,
  })
  const driver = {
    ...(options.controls
      ? {
          controls: () => options.controls!,
          execute: async (
            _action: ExtendedControlAction,
            _args: Record<string, unknown>,
            { beforeSend }: { beforeSend: () => boolean },
          ) => {
            driverEntries++
            if (beforeSend()) writes++
            return { acknowledged: true }
          },
        }
      : {}),
    prepare: async ({ binding }: { binding: typeof printerBinding }) => {
      if (readPrinterBinding(binding))
        dispatcher.observe(binding, observation())
      return { connectionGeneration: 1 }
    },
    closeAttempt: async () => {},
    pauseOnce: async ({ beforeSend }: { beforeSend: () => boolean }) => {
      driverEntries++
      if (beforeSend()) writes++
      return { acknowledged: true }
    },
    waitForPaused: async () => {
      wall += 1
      mono += 1
      sequence += 1
      return {
        ...observation(),
        printState: 'paused' as const,
      }
    },
  }
  const loopbackDriver = options.loopback?.driver({
    clock,
    observe: (binding, next) => dispatcher.observe(binding, next),
  })
  const dispatcher = createPauseDispatcher({
    authority: {
      issuers: [
        {
          issuer: 'farm:issuer',
          kid: 'issuer-1',
          publicKey: authority.issuer.publicKey,
        },
      ],
    },
    clock,
    journal,
    driver: loopbackDriver ?? driver,
    resultTimeoutMs: 1000,
    ...(options.storageDegraded
      ? { storageDegraded: options.storageDegraded }
      : {}),
  })
  if (!loopbackDriver) dispatcher.observe(printerBinding, observation())
  const abandon = () => {
    dispatcher.close()
    closeCommandJournal(journal)
    if (owned) rmSync(directory, { recursive: true, force: true })
  }
  let admitted: Awaited<ReturnType<typeof dispatcher.admit>>
  try {
    await loopbackDriver?.detect(printerBinding)
    const peer = dispatcher.createPeer(1)
    const admission = dispatcher.beginAdmission({
      binding: authority.binding,
      printerBinding,
      peer: peer.peer,
    })
    const bindingHash = await controlBindingHash(authority.binding)
    const nonce = admission.challenge.admissionNonce
    const issuedAt = clock.wallNow()
    const capability: PauseCapabilityV1 = {
      v: 1,
      purpose: 'pause-authority',
      capability_id: authority.ids.capability_id,
      kid: 'issuer-1',
      issuer: 'farm:issuer',
      audience: authority.binding.audience,
      origin: authority.binding.origin,
      issued_at: issuedAt,
      expires_at: 30000,
      account_id: authority.ids.account_id,
      role: 'operator',
      farm_id: authority.ids.farm_id,
      agent_id: authority.ids.agent_id,
      key_id: authority.ids.key_id,
      assignment_id: authority.ids.assignment_id,
      transport_id: authority.ids.transport_id,
      browser_public_key: authority.publicKey,
      browser_thumbprint: authority.thumbprint,
      connector_fingerprint: authority.binding.connector_fingerprint,
      credential_jti: authority.binding.credential_jti,
      printer_key: authority.printerKey,
      control_binding_sha256: bindingHash,
      admission_nonce: nonce,
      actions: ['pause'],
      ...options.capability,
    }
    const challenge: PauseAdmissionChallenge = {
      v: 1,
      purpose: 'pause-admission',
      challenge_id: randomUUID(),
      farm_id: authority.ids.farm_id,
      agent_id: authority.ids.agent_id,
      key_id: authority.ids.key_id,
      assignment_id: authority.ids.assignment_id,
      transport_id: authority.ids.transport_id,
      account_id: authority.ids.account_id,
      browser_thumbprint: authority.thumbprint,
      origin: authority.binding.origin,
      audience: authority.binding.audience,
      control_binding_sha256: bindingHash,
      admission_nonce: nonce,
      issued_at: issuedAt,
      expires_at: issuedAt + 8000,
    }
    admitted = await dispatcher.admit(admission.token, {
      capabilityWire: encodePauseCapability(
        await signPauseCapability(capability, authority.issuer.privateKey),
      ),
      admissionProofWire: encodePauseAdmissionProof(
        await authority.signer.signAdmissionProof(challenge),
      ),
      browserProofWire: encodeControlProof({
        v: 1,
        role: 'browser',
        binding: authority.binding,
        signature: await authority.signer.signControlProof(authority.binding),
      }),
      connectorProofWire: encodeControlProof({
        v: 1,
        role: 'connector',
        binding: authority.binding,
        signature: await signControlSessionProof(
          authority.binding,
          'connector',
          authority.connector.privateKey,
        ),
      }),
      ...(options.capabilityWire && {
        capabilityWire: await options.capabilityWire(
          capability,
          authority.issuer.privateKey,
        ),
      }),
    })
    if (!admitted.ok)
      throw new Error(`Capability admission failed: ${admitted.reason}`)
  } catch (error) {
    abandon()
    throw error
  }
  let closed = false
  return {
    dispatcher,
    printerBinding,
    handle: admitted.handle,
    journal,
    directory,
    /** Dispatches with the admitted handle, or with an explicit (possibly invalid) one. */
    dispatch(wire: unknown, ...handle: [unknown?]) {
      return dispatcher.dispatch({
        wire,
        capability: handle.length ? handle[0] : admitted.handle,
        printerBinding,
      })
    },
    /** Rows the durable journal accepted (claims), read from disk. */
    claims(): number {
      const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'), {
        readOnly: true,
      })
      try {
        return Number(
          db.prepare('SELECT count(*) AS n FROM pause_commands').get()?.n,
        )
      } finally {
        db.close()
      }
    },
    writes: () => writes,
    now: clock.wallNow,
    driverEntries: () => driverEntries,
    advance(ms: number) {
      wall += ms
      mono += ms
    },
    /** Moves only the journal's clock (for clock-regression checks). */
    setJournalWall(value: number | undefined) {
      journalWall = value
    },
    revoke: () => dispatcher.revoke(admitted.handle),
    closeJournal: () => closeCommandJournal(journal),
    close() {
      if (closed) return
      closed = true
      dispatcher.close()
      try {
        closeCommandJournal(journal)
      } catch {
        /* already closed */
      }
      if (owned) rmSync(directory, { recursive: true, force: true })
    },
  }
}
export type V2Dispatch = Awaited<ReturnType<typeof openV2Dispatch>>

export const rejected = (
  reason: Extract<PauseDispatchResult, { kind: 'rejected' }>['reason'],
) => ({ kind: 'rejected', reason }) as const

export type { ExtendedControlAction }
