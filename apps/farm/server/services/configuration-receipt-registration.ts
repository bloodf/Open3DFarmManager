import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { decodeBase64url } from '../../../../packages/farm-protocol/src/encoding.ts'
import { PairingProofAudience } from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import {
  CONFIGURATION_HARD_MAXIMUMS,
  CONFIGURATION_PROTOCOL,
  MAX_CONFIGURATION_PROOF_WIRE_BYTES,
  requireEd25519Private,
} from '../../../../packages/farm-protocol/src/configuration-common.ts'
import {
  deriveConfigurationAssignmentIdentity,
  encodeConfigurationInventoryAck,
  signConfigurationInventoryAck,
} from '../../../../packages/farm-protocol/src/configuration-inventory.ts'
import {
  configurationReceiptHash,
  configurationReceiptMatchesContext,
  decodeConfigurationReceipt,
  verifyConfigurationReceipt,
  type SignedConfigurationReceipt,
} from '../../../../packages/farm-protocol/src/configuration-receipt.ts'
import {
  configurationFailure,
  currentConfigurationAuthority,
  type ConfigurationAuthorityStore,
  type ConfigurationFailure,
  type ConfigurationLiveRegistry,
} from './configuration-authority-contract.ts'
import type { ConfigurationIssuerConfig } from './configuration-authority.ts'

const RegistrationInput = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  farmId: BrowserDeviceUuid,
  request: z.strictObject({
    keyId: BrowserDeviceUuid,
    receiptWire: z.string().min(1).max(MAX_CONFIGURATION_PROOF_WIRE_BYTES),
  }),
})
const BootstrapInput = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  keyId: BrowserDeviceUuid,
})
const Issuer = z.strictObject({
  issuer: PairingProofAudience,
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  privateKey: z.custom<CryptoKey>((value) => value instanceof CryptoKey),
})
export type ConfigurationRegistrationResult =
  | {
      ok: true
      assignmentId: string
      printerKey: string
      receiptSha256: string
      status: 'active'
      /** True when this exact receipt had been registered before (lost acknowledgement). */
      replayed: boolean
      inventoryAckWire: string
    }
  | ConfigurationFailure
export type ConfigurationBootstrapResult =
  | {
      ok: true
      protocol: typeof CONFIGURATION_PROTOCOL
      role: 'owner' | 'admin'
      /** Advisory liveness of an authenticated, locally enabled Connector. */
      available: boolean
      revision: number | null
      connectorFingerprint: string
      origin: string
      audience: string
    }
  | ConfigurationFailure

const denied = () => configurationFailure('denied')

function connectorKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    new Uint8Array(decodeBase64url(spki, 44)),
    { name: 'Ed25519' },
    true,
    ['verify'],
  )
}

/**
 * Central inventory registration from a Connector-signed committed receipt.
 * Trust comes only from the enrolled Connector key and current owner/admin
 * authority read in the same transaction as the insert; a callback, capability
 * or request claim is never enough. Legacy manual registration is untouched.
 */
export function createConfigurationRegistrationService(input: {
  store: ConfigurationAuthorityStore
  registry: ConfigurationLiveRegistry
  issuer: ConfigurationIssuerConfig
}) {
  const { store, registry } = input
  const issuer = Object.freeze(Issuer.parse(input.issuer))
  requireEd25519Private(issuer.privateKey, 'configuration inventory issuer')
  let active = 0
  async function operation<T>(
    action: () => Promise<T | ConfigurationFailure>,
  ): Promise<T | ConfigurationFailure> {
    if (active >= 8) return configurationFailure('capacity')
    active++
    try {
      return await action()
    } catch {
      return configurationFailure('storage-unavailable')
    } finally {
      active--
    }
  }
  return Object.freeze({
    /** Works for a Connector with zero printers; says nothing about write permission. */
    bootstrap(raw: unknown): Promise<ConfigurationBootstrapResult> {
      return operation<ConfigurationBootstrapResult>(async () => {
        const parsed = BootstrapInput.safeParse(raw)
        if (!parsed.success) return configurationFailure('invalid-input')
        const scope = parsed.data
        return store.transaction(scope, async (tx) => {
          const a = currentConfigurationAuthority(tx, scope)
          if (!a) return denied()
          const live = registry.advertised(a.farm_id, a.agent_id)
          const current = live && live.jti === a.credential_jti ? live : null
          return {
            ok: true as const,
            protocol: CONFIGURATION_PROTOCOL,
            role: a.role,
            available: current !== null,
            revision: current ? current.revision : null,
            connectorFingerprint: a.connector_fingerprint,
            origin: a.origin,
            audience: a.audience,
          }
        })
      })
    },
    register(raw: unknown): Promise<ConfigurationRegistrationResult> {
      return operation<ConfigurationRegistrationResult>(async () => {
        const parsed = RegistrationInput.safeParse(raw)
        if (!parsed.success) return configurationFailure('invalid-input')
        let receipt: SignedConfigurationReceipt
        try {
          receipt = decodeConfigurationReceipt(parsed.data.request.receiptWire)
        } catch {
          return configurationFailure('invalid-input')
        }
        // Only a durable local commit is evidence; prepared/recovery receipts never register.
        if (
          receipt.phase !== 'local-committed' ||
          receipt.committed_revision === null ||
          receipt.farm_id !== parsed.data.farmId
        )
          return denied()
        const committedRevision = receipt.committed_revision
        const receiptSha256 = await configurationReceiptHash(receipt)
        const scope = {
          sessionRecordId: parsed.data.sessionRecordId,
          farmId: parsed.data.farmId,
          agentId: receipt.agent_id,
          keyId: parsed.data.request.keyId,
        }
        return store.transaction(scope, async (tx) => {
          const a = currentConfigurationAuthority(tx, scope)
          const now = tx.observedAt
          if (!a) return denied()
          const identity = await deriveConfigurationAssignmentIdentity({
            account_id: a.account_id,
            farm_id: a.farm_id,
            agent_id: a.agent_id,
            bridge_instance_id: receipt.target.bridge_instance_id,
            device_id: receipt.target.device_id,
          })
          const op = await tx.operation(receipt.operation_id)
          if (
            !op ||
            op.key_id !== a.key_id ||
            op.commit_sha256 === null ||
            receipt.prior_receipt_sha256 !== op.commit_sha256 ||
            receipt.connector_fingerprint !== a.connector_fingerprint ||
            !configurationReceiptMatchesContext(receipt, {
              account_id: a.account_id,
              farm_id: a.farm_id,
              agent_id: a.agent_id,
              operation_id: op.operation_id,
              target_sha256: op.target_sha256,
              device_id: receipt.target.device_id,
              expected_revision: op.expected_revision,
            }) ||
            op.account_id !== a.account_id ||
            op.farm_id !== a.farm_id ||
            op.agent_id !== a.agent_id ||
            receipt.issued_at <
              op.created_at - CONFIGURATION_HARD_MAXIMUMS.skewMs ||
            receipt.issued_at > now + CONFIGURATION_HARD_MAXIMUMS.skewMs ||
            !(await verifyConfigurationReceipt(
              receipt,
              await connectorKey(a.connector_public_key_spki),
            ))
          )
            return denied()
          const context = registry.activeContext({
            sessionRecordId: parsed.data.sessionRecordId,
            farmId: a.farm_id,
            agentId: a.agent_id,
            keyId: a.key_id,
            accountId: a.account_id,
            credentialJti: a.credential_jti,
          })
          if (!context) return denied()
          const expiresAt = Math.min(
            now + CONFIGURATION_HARD_MAXIMUMS.bindingMs,
            context.expiresAt,
            a.validUntil,
          )
          if (expiresAt <= now) return denied()
          const existing = await tx.receipt(op.operation_id)
          if (existing) {
            if (
              existing.receipt_sha256 !== receiptSha256 ||
              existing.assignment_id !== identity.assignment_id
            )
              return configurationFailure('conflict')
          } else {
            const registered = await tx.registerReceipt({
              operation_id: op.operation_id,
              receipt_sha256: receiptSha256,
              receipt_wire: parsed.data.request.receiptWire,
              farm_id: a.farm_id,
              agent_id: a.agent_id,
              account_id: a.account_id,
              bridge_instance_id: receipt.target.bridge_instance_id,
              device_id: receipt.target.device_id,
              assignment_id: identity.assignment_id,
              printer_key: identity.printer_key,
              committed_revision: committedRevision,
              registered_at: now,
            })
            if (
              !registered.ok ||
              BrowserDeviceUuid.parse(registered.assignmentId) !==
                identity.assignment_id
            )
              return configurationFailure('conflict')
          }
          const ack = await signConfigurationInventoryAck(
            {
              v: 1,
              protocol: CONFIGURATION_PROTOCOL,
              purpose: 'configuration-inventory-ack',
              context: {
                account_id: a.account_id,
                farm_id: a.farm_id,
                agent_id: a.agent_id,
                key_id: a.key_id,
                transport_id: context.transportId,
                browser_thumbprint: a.browser_thumbprint,
                connector_fingerprint: a.connector_fingerprint,
                credential_jti: a.credential_jti,
                configuration_binding_sha256: context.bindingSha256,
                origin: a.origin,
                audience: a.audience,
              },
              kid: issuer.kid,
              issuer: issuer.issuer,
              operation_id: op.operation_id,
              committed_receipt_sha256: receiptSha256,
              committed_revision: committedRevision,
              assignment_id: identity.assignment_id,
              printer_key: identity.printer_key,
              nonce: randomBytes(32).toString('base64url'),
              issued_at: now,
              expires_at: expiresAt,
            },
            issuer.privateKey,
          )
          return {
            ok: true as const,
            assignmentId: identity.assignment_id,
            printerKey: identity.printer_key,
            receiptSha256,
            status: 'active' as const,
            replayed: existing !== null,
            inventoryAckWire: encodeConfigurationInventoryAck(ack),
          }
        })
      })
    },
  })
}
export type ConfigurationRegistrationService = ReturnType<
  typeof createConfigurationRegistrationService
>
