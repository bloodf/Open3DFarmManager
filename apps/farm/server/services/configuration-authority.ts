import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { canonicalize } from '../../../../packages/farm-protocol/src/canonical.ts'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { PairingProofAudience } from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import {
  configurationBindingHash,
  decodeConfigurationSessionProof,
  verifyConfigurationSessionPair,
  type ConfigurationSessionBinding,
} from '../../../../packages/farm-protocol/src/configuration-binding.ts'
import {
  ConfigurationAdmissionChallenge,
  decodeConfigurationAdmissionProof,
  signConfigurationCapability,
  verifyConfigurationAdmissionProof,
  type SignedConfigurationCapabilityV1,
} from '../../../../packages/farm-protocol/src/configuration-capability.ts'
import {
  CONFIGURATION_HARD_MAXIMUMS,
  CONFIGURATION_PROTOCOL,
  ConfigurationAction,
  MAX_CONFIGURATION_PROOF_WIRE_BYTES,
  configurationDigest,
  configurationFresh,
  requireEd25519Private,
} from '../../../../packages/farm-protocol/src/configuration-common.ts'
import {
  configurationAuthorityMatchesBinding,
  configurationAuthorityPins,
  configurationFailure,
  currentConfigurationAuthority,
  type ConfigurationAuthority,
  type ConfigurationAuthorityStore,
  type ConfigurationAuthorityTransaction,
  type ConfigurationFailure,
  type ConfigurationLiveRegistry,
} from './configuration-authority-contract.ts'

const revision = z.number().int().nonnegative().max(2_147_483_646)
const proofWire = z.string().min(1).max(MAX_CONFIGURATION_PROOF_WIRE_BYTES)
export const ConfigurationChallengeRequest = z.strictObject({
  browserProofWire: proofWire,
  connectorProofWire: proofWire,
  admissionNonce: configurationDigest,
  action: ConfigurationAction,
  operationId: BrowserDeviceUuid,
  expectedRevision: revision,
  targetSha256: configurationDigest,
})
export type ConfigurationChallengeRequest = z.infer<
  typeof ConfigurationChallengeRequest
>
export const ConfigurationCapabilityRequest = z.strictObject({
  admissionProofWire: proofWire,
})
const ChallengeInput = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  request: ConfigurationChallengeRequest,
})
const CapabilityInput = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  request: ConfigurationCapabilityRequest,
})
const Issuer = z.strictObject({
  issuer: PairingProofAudience,
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  privateKey: z.custom<CryptoKey>((value) => value instanceof CryptoKey),
})
export type ConfigurationIssuerConfig = z.infer<typeof Issuer>

export type ConfigurationChallengeResult =
  | { ok: true; challenge: ConfigurationAdmissionChallenge }
  | ConfigurationFailure
export type ConfigurationCapabilityResult =
  | { ok: true; capability: SignedConfigurationCapabilityV1 }
  | ConfigurationFailure

const denied = () => configurationFailure('denied')
const invalid = () => configurationFailure('invalid-input')

/**
 * Pins one operation ID to one account, device, Connector, revision and target.
 * prepare creates the operation; commit pins the prepared receipt hash once;
 * status/cancel must repeat the original prepare target. Any change is denied.
 */
async function admitOperation(
  tx: ConfigurationAuthorityTransaction,
  a: ConfigurationAuthority,
  request: Pick<
    ConfigurationChallengeRequest,
    'action' | 'operationId' | 'expectedRevision' | 'targetSha256'
  >,
): Promise<boolean> {
  const existing = await tx.operation(request.operationId)
  if (!existing)
    return (
      request.action === 'prepare' &&
      (await tx.createOperation({
        operation_id: request.operationId,
        account_id: a.account_id,
        farm_id: a.farm_id,
        agent_id: a.agent_id,
        key_id: a.key_id,
        expected_revision: request.expectedRevision,
        target_sha256: request.targetSha256,
        commit_sha256: null,
        created_at: tx.observedAt,
      }))
    )
  if (
    existing.account_id !== a.account_id ||
    existing.farm_id !== a.farm_id ||
    existing.agent_id !== a.agent_id ||
    existing.key_id !== a.key_id ||
    existing.expected_revision !== request.expectedRevision
  )
    return false
  const registered = await tx.receipt(request.operationId)
  if (request.action !== 'commit')
    return (
      existing.target_sha256 === request.targetSha256 &&
      (request.action !== 'prepare' || !registered)
    )
  if (registered) return false
  return existing.commit_sha256 === null
    ? tx.pinCommit(request.operationId, request.targetSha256)
    : existing.commit_sha256 === request.targetSha256
}

/**
 * config-v1 capability issuer. Dedicated key and signing domain: it signs only
 * claims this server assembled from locked current authority, a binding its own
 * signalling issued and both peers proved, and one stored admission challenge.
 * It never signs caller-supplied bytes and never sees an action payload.
 */
export function createConfigurationAuthorityService(input: {
  store: ConfigurationAuthorityStore
  registry: ConfigurationLiveRegistry
  issuer: ConfigurationIssuerConfig
}) {
  const { store, registry } = input
  const issuer = Object.freeze(Issuer.parse(input.issuer))
  requireEd25519Private(issuer.privateKey, 'configuration issuer')
  let active = 0
  let closed = false

  async function operation<T>(
    action: () => Promise<T | ConfigurationFailure>,
  ): Promise<T | ConfigurationFailure> {
    if (closed) return denied()
    if (active >= 8) return configurationFailure('capacity')
    active++
    try {
      return await action()
    } catch {
      // Unavailable is not proof that nothing was committed. Never retried here.
      return configurationFailure('storage-unavailable')
    } finally {
      active--
    }
  }
  /** The binding must be one this process issued and the Connector must still be current. */
  function liveBinding(
    bindingSha256: string,
    binding: Pick<
      ConfigurationSessionBinding,
      'transport_id' | 'farm_id' | 'agent_id' | 'credential_jti'
    >,
  ) {
    const bound = registry.bound(bindingSha256)
    const advertised = registry.advertised(binding.farm_id, binding.agent_id)
    return bound &&
      bound.transportId === binding.transport_id &&
      advertised &&
      advertised.jti === binding.credential_jti
      ? bound
      : null
  }

  return Object.freeze({
    issuerKid: issuer.kid,
    issueChallenge(raw: unknown): Promise<ConfigurationChallengeResult> {
      return operation<ConfigurationChallengeResult>(async () => {
        const parsed = ChallengeInput.safeParse(raw)
        if (!parsed.success) return invalid()
        const { sessionRecordId, request } = parsed.data
        let binding: ConfigurationSessionBinding | null
        try {
          binding = await verifyConfigurationSessionPair(
            decodeConfigurationSessionProof(request.browserProofWire),
            decodeConfigurationSessionProof(request.connectorProofWire),
          )
        } catch {
          return invalid()
        }
        if (!binding) return denied()
        const bindingSha256 = await configurationBindingHash(binding)
        if (!liveBinding(bindingSha256, binding)) return denied()
        const scope = {
          sessionRecordId,
          farmId: binding.farm_id,
          agentId: binding.agent_id,
          keyId: binding.key_id,
        }
        return store.transaction(scope, async (tx) => {
          const a = currentConfigurationAuthority(tx, scope)
          const now = tx.observedAt
          const bound = liveBinding(bindingSha256, binding)
          if (
            !a ||
            !bound ||
            !configurationAuthorityMatchesBinding(a, binding) ||
            !configurationFresh(binding, now)
          )
            return denied()
          const expiresAt = Math.min(
            now + CONFIGURATION_HARD_MAXIMUMS.admissionMs,
            binding.expires_at,
            bound.expiresAt,
            a.validUntil,
          )
          if (expiresAt <= now || !(await admitOperation(tx, a, request)))
            return denied()
          const challenge = ConfigurationAdmissionChallenge.parse({
            v: 1,
            purpose: 'configuration-admission',
            protocol: CONFIGURATION_PROTOCOL,
            challenge_id: randomUUID(),
            capability_id: randomUUID(),
            farm_id: a.farm_id,
            agent_id: a.agent_id,
            key_id: a.key_id,
            transport_id: binding.transport_id,
            account_id: a.account_id,
            browser_thumbprint: a.browser_thumbprint,
            origin: a.origin,
            audience: a.audience,
            configuration_binding_sha256: bindingSha256,
            admission_nonce: request.admissionNonce,
            action: request.action,
            operation_id: request.operationId,
            expected_revision: request.expectedRevision,
            target_sha256: request.targetSha256,
            issued_at: now,
            expires_at: expiresAt,
          })
          const stored = await tx.insertChallenge({
            challenge,
            pins: configurationAuthorityPins(a),
          })
          return stored ? { ok: true as const, challenge } : denied()
        })
      })
    },
    issueCapability(raw: unknown): Promise<ConfigurationCapabilityResult> {
      return operation<ConfigurationCapabilityResult>(async () => {
        const parsed = CapabilityInput.safeParse(raw)
        if (!parsed.success) return invalid()
        let proof: ReturnType<typeof decodeConfigurationAdmissionProof>
        try {
          proof = decodeConfigurationAdmissionProof(
            parsed.data.request.admissionProofWire,
          )
        } catch {
          return invalid()
        }
        const claimed = proof.challenge
        const scope = {
          sessionRecordId: parsed.data.sessionRecordId,
          farmId: claimed.farm_id,
          agentId: claimed.agent_id,
          keyId: claimed.key_id,
        }
        return store.transaction(scope, async (tx) => {
          // Consumed first: a replayed or failed admission can never be reused.
          const stored = await tx.consumeChallenge(claimed.challenge_id)
          const a = currentConfigurationAuthority(tx, scope)
          const now = tx.observedAt
          if (
            !stored ||
            !a ||
            canonicalize(stored.challenge) !== canonicalize(claimed) ||
            configurationAuthorityPins(a) !== stored.pins ||
            !configurationFresh(stored.challenge, now) ||
            !(await verifyConfigurationAdmissionProof(
              proof,
              a.browser_public_key,
            ))
          )
            return denied()
          const challenge = stored.challenge
          const bound = liveBinding(challenge.configuration_binding_sha256, {
            transport_id: challenge.transport_id,
            farm_id: a.farm_id,
            agent_id: a.agent_id,
            credential_jti: a.credential_jti,
          })
          const op = await tx.operation(challenge.operation_id)
          if (
            !bound ||
            !op ||
            op.account_id !== a.account_id ||
            op.agent_id !== a.agent_id ||
            op.key_id !== a.key_id ||
            op.expected_revision !== challenge.expected_revision ||
            (challenge.action === 'commit'
              ? op.commit_sha256 !== challenge.target_sha256
              : op.target_sha256 !== challenge.target_sha256) ||
            (challenge.action !== 'status' &&
              challenge.action !== 'cancel' &&
              (await tx.receipt(challenge.operation_id)))
          )
            return denied()
          const expiresAt = Math.min(
            now + CONFIGURATION_HARD_MAXIMUMS.capabilityMs,
            bound.expiresAt,
            a.validUntil,
          )
          // The admission proof must stay inside the capability lifetime.
          if (expiresAt < challenge.expires_at) return denied()
          const capability = await signConfigurationCapability(
            {
              v: 1,
              purpose: 'configuration-authority',
              protocol: CONFIGURATION_PROTOCOL,
              capability_id: challenge.capability_id,
              kid: issuer.kid,
              issuer: issuer.issuer,
              audience: a.audience,
              origin: a.origin,
              issued_at: now,
              expires_at: expiresAt,
              account_id: a.account_id,
              role: a.role,
              farm_id: a.farm_id,
              agent_id: a.agent_id,
              key_id: a.key_id,
              transport_id: challenge.transport_id,
              browser_public_key: a.browser_public_key,
              browser_thumbprint: a.browser_thumbprint,
              connector_fingerprint: a.connector_fingerprint,
              credential_jti: a.credential_jti,
              configuration_binding_sha256:
                challenge.configuration_binding_sha256,
              admission_nonce: challenge.admission_nonce,
              action: challenge.action,
              operation_id: challenge.operation_id,
              expected_revision: challenge.expected_revision,
              target_sha256: challenge.target_sha256,
            },
            issuer.privateKey,
          )
          return { ok: true as const, capability }
        })
      })
    },
    /** Stops new work only; an issued capability keeps its original short expiry. */
    close(): void {
      closed = true
    },
  })
}
export type ConfigurationAuthorityService = ReturnType<
  typeof createConfigurationAuthorityService
>
