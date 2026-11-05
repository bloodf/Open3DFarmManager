import { randomBytes } from 'node:crypto'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import {
  ControlSessionBinding,
  controlBindingHash,
  decodeControlProof,
  verifyControlSessionProof,
} from '../../../farm-protocol/src/control-session-binding.ts'
import {
  PauseCapabilityV1,
  PausePolicy,
  PAUSE_POLICY_HARD_MAXIMUMS,
  decodePauseCapability,
  decodePauseAdmissionProof,
  verifyPauseCapability,
  verifyPauseAdmissionProof,
  type SignedPauseCapabilityV1,
} from '../../../farm-protocol/src/pause-capability.ts'
import {
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'

export type PauseAuthorityClock = { wallNow(): number; monotonicNow(): number }
export type PauseIssuer = { issuer: string; kid: string; publicKey: CryptoKey }
class AdmissionToken {
  #opaque = true
  constructor() {
    Object.freeze(this)
  }
  toJSON(): never {
    throw new Error('Pause admission tokens cannot be serialized')
  }
}
Object.freeze(AdmissionToken.prototype)
export type PauseAdmissionToken = AdmissionToken
class CapabilityHandle {
  #opaque = true
  constructor() {
    Object.freeze(this)
  }
  toJSON(): never {
    throw new Error('Pause capability handles cannot be serialized')
  }
}
Object.freeze(CapabilityHandle.prototype)
export type PauseCapabilityHandle = CapabilityHandle
export type PauseCapabilitySnapshot = Readonly<
  Omit<SignedPauseCapabilityV1, 'browser_public_key' | 'actions'>
> & {
  readonly browser_public_key: Readonly<
    SignedPauseCapabilityV1['browser_public_key']
  >
  readonly actions: readonly ['pause']
}
type ClockSample = { wall: number; mono: number }
type Peer = {
  binding: ControlSessionBinding
  printerBinding: PrinterBinding
  peerGeneration: number
  currentPeerGeneration(): number
}
type Admission = Peer & {
  start: ClockSample
  nonce: string
  deadline: number
  consumed: boolean
}
type Authority = Peer & {
  capability: PauseCapabilitySnapshot
  deadline: number
}
export type PauseCapabilityRejection =
  | 'invalid-admission'
  | 'invalid-proof'
  | 'scope-mismatch'
  | 'untrusted-issuer'
  | 'signature-rejected'
  | 'expired-or-inactive'
export type PauseCapabilityDecision =
  | { ok: true; handle: PauseCapabilityHandle }
  | { ok: false; reason: PauseCapabilityRejection }

/**
 * Explicit local provisioning/adapter seam, not a network adapter. A trusted caller pins the
 * actual control peer transcript, generation and printer mapping. Shape validation alone
 * never authenticates those inputs. No command, driver or dispatch operation is provided.
 */
export function createPauseCapabilityVerifier(config: {
  issuers: readonly PauseIssuer[]
  clock: PauseAuthorityClock
  policy?: Partial<PausePolicy>
}) {
  const policy = Object.freeze(
    PausePolicy.parse({
      ...PAUSE_POLICY_HARD_MAXIMUMS,
      ...PausePolicy.partial().parse(config.policy ?? {}),
    }),
  )
  if (!config.issuers.length || config.issuers.length > 128)
    throw new Error('Invalid pause issuer keyring')
  const issuers = new Map<string, CryptoKey>()
  for (const entry of config.issuers) {
    const issuer = PauseCapabilityV1.shape.issuer.parse(entry.issuer)
    const kid = PauseCapabilityV1.shape.kid.parse(entry.kid)
    const key = entry.publicKey
    if (
      !(key instanceof CryptoKey) ||
      key.type !== 'public' ||
      key.algorithm.name !== 'Ed25519' ||
      key.usages.length !== 1 ||
      key.usages[0] !== 'verify'
    )
      throw new Error('Expected a trusted Ed25519 verification key')
    const name = issuer + '\0' + kid
    if (issuers.has(name)) throw new Error('Duplicate pause issuer')
    issuers.set(name, key)
  }
  // Snapshot callbacks as well as the keyring: later config mutation cannot change authority.
  const wallNow = config.clock.wallNow.bind(config.clock)
  const monotonicNow = config.clock.monotonicNow.bind(config.clock)
  let baseline: ClockSample | undefined
  let previous: ClockSample | undefined
  let clockBroken = false
  const admissions = new WeakMap<AdmissionToken, Admission>()
  const handles = new WeakMap<CapabilityHandle, Authority>()
  function sample(): ClockSample | null {
    if (clockBroken) return null
    try {
      const next = { wall: wallNow(), mono: monotonicNow() }
      if (
        !Number.isSafeInteger(next.wall) ||
        next.wall < 0 ||
        !Number.isFinite(next.mono) ||
        next.mono < 0 ||
        next.mono > Number.MAX_SAFE_INTEGER - policy.capabilityMs ||
        (previous &&
          (next.wall < previous.wall || next.mono < previous.mono)) ||
        (baseline &&
          Math.abs(next.wall - baseline.wall - (next.mono - baseline.mono)) >
            1000)
      )
        throw new Error('Untrustworthy local clock')
      baseline ??= next
      previous = next
      return next
    } catch {
      clockBroken = true
      return null
    }
  }
  function peerCurrent(peer: Peer, now: ClockSample): boolean {
    try {
      const assignment = readPrinterBinding(peer.printerBinding)
      return Boolean(
        assignment &&
          assignment.assignment_id === peer.binding.assignment_id &&
          assignment.farm_id === peer.binding.farm_id &&
          assignment.agent_id === peer.binding.agent_id &&
          peer.currentPeerGeneration() === peer.peerGeneration &&
          now.wall >= peer.binding.issued_at &&
          now.wall < peer.binding.expires_at,
      )
    } catch {
      return false
    }
  }
  function admissionCurrent(admission: Admission): ClockSample | null {
    const now = sample()
    return now &&
      now.mono < admission.deadline &&
      now.wall < admission.start.wall + policy.admissionMs &&
      peerCurrent(admission, now)
      ? now
      : null
  }
  return Object.freeze({
    policy,
    beginAdmission(input: {
      binding: unknown
      printerBinding: PrinterBinding
      peerGeneration: number
      currentPeerGeneration(): number
    }) {
      // Capture both deadlines before validation or any asynchronous cryptographic work.
      const start = sample()
      if (
        !start ||
        !Number.isSafeInteger(start.wall + policy.admissionMs) ||
        !Number.isFinite(start.mono + policy.capabilityMs) ||
        start.mono + policy.admissionMs <= start.mono
      )
        throw new Error('Untrustworthy local clock')
      const binding = ControlSessionBinding.parse(input.binding)
      Object.freeze(binding.browser_public_key)
      Object.freeze(binding)
      if (
        !Number.isSafeInteger(input.peerGeneration) ||
        input.peerGeneration < 0 ||
        typeof input.currentPeerGeneration !== 'function'
      )
        throw new Error('Invalid local peer generation')
      const admission: Admission = {
        binding,
        printerBinding: input.printerBinding,
        peerGeneration: input.peerGeneration,
        currentPeerGeneration: input.currentPeerGeneration,
        start,
        nonce: randomBytes(32).toString('base64url'),
        deadline: start.mono + policy.admissionMs,
        consumed: false,
      }
      if (!peerCurrent(admission, start))
        throw new Error('Inactive local control peer or assignment')
      const token = new AdmissionToken()
      admissions.set(token, admission)
      return Object.freeze({
        token,
        challenge: Object.freeze({
          admissionNonce: admission.nonce,
          issuedAt: start.wall,
          expiresAt: Math.min(
            start.wall + policy.admissionMs,
            binding.expires_at,
          ),
        }),
      })
    },
    async admit(
      token: unknown,
      input: {
        capabilityWire: unknown
        browserProofWire: unknown
        connectorProofWire: unknown
        admissionProofWire: unknown
      },
    ): Promise<PauseCapabilityDecision> {
      if (!(token instanceof AdmissionToken))
        return { ok: false, reason: 'invalid-admission' }
      const admission = admissions.get(token)
      if (!admission || admission.consumed)
        return { ok: false, reason: 'invalid-admission' }
      admission.consumed = true // All failures are terminal, including concurrent attempts.
      if (!admissionCurrent(admission))
        return { ok: false, reason: 'expired-or-inactive' }
      try {
        const capability = decodePauseCapability(input.capabilityWire)
        const browserProof = decodeControlProof(input.browserProofWire)
        const connectorProof = decodeControlProof(input.connectorProofWire)
        const proof = decodePauseAdmissionProof(input.admissionProofWire)
        const expected = admission.binding
        const assignment = readPrinterBinding(admission.printerBinding)
        if (!assignment) return { ok: false, reason: 'expired-or-inactive' }
        const expectedCanonical = canonicalize(expected)
        if (
          browserProof.role !== 'browser' ||
          connectorProof.role !== 'connector' ||
          canonicalize(browserProof.binding) !== expectedCanonical ||
          canonicalize(connectorProof.binding) !== expectedCanonical ||
          capability.farm_id !== expected.farm_id ||
          capability.agent_id !== expected.agent_id ||
          capability.account_id !== expected.account_id ||
          capability.key_id !== expected.key_id ||
          capability.assignment_id !== expected.assignment_id ||
          capability.transport_id !== expected.transport_id ||
          capability.origin !== expected.origin ||
          capability.audience !== expected.audience ||
          capability.browser_thumbprint !== expected.browser_thumbprint ||
          canonicalize(capability.browser_public_key) !==
            canonicalize(expected.browser_public_key) ||
          capability.connector_fingerprint !== expected.connector_fingerprint ||
          capability.credential_jti !== expected.credential_jti ||
          capability.printer_key !== assignment.printer_key ||
          capability.admission_nonce !== admission.nonce ||
          capability.expires_at > expected.expires_at ||
          capability.expires_at - capability.issued_at > policy.capabilityMs ||
          capability.issued_at < admission.start.wall
        )
          return { ok: false, reason: 'scope-mismatch' }
        const challenge = proof.challenge
        if (
          challenge.farm_id !== expected.farm_id ||
          challenge.agent_id !== expected.agent_id ||
          challenge.account_id !== expected.account_id ||
          challenge.key_id !== expected.key_id ||
          challenge.assignment_id !== expected.assignment_id ||
          challenge.transport_id !== expected.transport_id ||
          challenge.browser_thumbprint !== expected.browser_thumbprint ||
          challenge.origin !== expected.origin ||
          challenge.audience !== expected.audience ||
          challenge.admission_nonce !== admission.nonce ||
          challenge.control_binding_sha256 !==
            capability.control_binding_sha256 ||
          challenge.issued_at < admission.start.wall ||
          challenge.expires_at - challenge.issued_at > policy.admissionMs ||
          capability.issued_at < challenge.issued_at
        )
          return { ok: false, reason: 'scope-mismatch' }
        const key = issuers.get(capability.issuer + '\0' + capability.kid)
        if (!key) return { ok: false, reason: 'untrusted-issuer' }
        const fresh = () => {
          const now = admissionCurrent(admission)
          return (
            now &&
            now.wall >= capability.issued_at &&
            now.wall < capability.expires_at &&
            now.wall >= challenge.issued_at &&
            now.wall < challenge.expires_at
          )
        }
        if (!fresh()) return { ok: false, reason: 'expired-or-inactive' }
        if (
          (await controlBindingHash(expected)) !==
          capability.control_binding_sha256
        )
          return { ok: false, reason: 'scope-mismatch' }
        if (!fresh()) return { ok: false, reason: 'expired-or-inactive' }
        if (!(await verifyPauseCapability(capability, key)))
          return { ok: false, reason: 'signature-rejected' }
        if (!fresh()) return { ok: false, reason: 'expired-or-inactive' }
        if (
          !(await verifyControlSessionProof(
            expected,
            'browser',
            browserProof.signature,
          ))
        )
          return { ok: false, reason: 'signature-rejected' }
        if (!fresh()) return { ok: false, reason: 'expired-or-inactive' }
        if (
          !(await verifyControlSessionProof(
            expected,
            'connector',
            connectorProof.signature,
          ))
        )
          return { ok: false, reason: 'signature-rejected' }
        if (!fresh()) return { ok: false, reason: 'expired-or-inactive' }
        if (
          !(await verifyPauseAdmissionProof(proof, expected.browser_public_key))
        )
          return { ok: false, reason: 'signature-rejected' }
        if (!fresh()) return { ok: false, reason: 'expired-or-inactive' }
        Object.freeze(capability.browser_public_key)
        Object.freeze(capability.actions)
        Object.freeze(capability)
        const handle = new CapabilityHandle()
        handles.set(handle, {
          binding: expected,
          printerBinding: admission.printerBinding,
          peerGeneration: admission.peerGeneration,
          currentPeerGeneration: admission.currentPeerGeneration,
          capability,
          deadline:
            admission.start.mono +
            Math.min(
              policy.capabilityMs,
              capability.expires_at - admission.start.wall,
              expected.expires_at - admission.start.wall,
            ),
        })
        return { ok: true, handle }
      } catch {
        return { ok: false, reason: 'invalid-proof' }
      }
    },
    inspect(handle: unknown):
      | {
          ok: true
          capability: PauseCapabilitySnapshot
          policy: Readonly<PausePolicy>
        }
      | { ok: false; reason: 'expired-or-inactive' } {
      if (!(handle instanceof CapabilityHandle))
        return { ok: false, reason: 'expired-or-inactive' }
      const authority = handles.get(handle)
      const now = sample()
      if (
        !authority ||
        !now ||
        now.mono >= authority.deadline ||
        now.wall < authority.capability.issued_at ||
        now.wall >= authority.capability.expires_at ||
        !peerCurrent(authority, now)
      ) {
        handles.delete(handle) // An observed closure or deadline is terminal, even if callbacks later change back.
        return { ok: false, reason: 'expired-or-inactive' }
      }
      return { ok: true, capability: authority.capability, policy }
    },
  })
}
