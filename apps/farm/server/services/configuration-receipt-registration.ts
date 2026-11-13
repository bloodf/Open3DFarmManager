import { z } from 'zod'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { decodeBase64url } from '../../../../packages/farm-protocol/src/encoding.ts'
import {
  CONFIGURATION_HARD_MAXIMUMS,
  CONFIGURATION_PROTOCOL,
  MAX_CONFIGURATION_PROOF_WIRE_BYTES,
} from '../../../../packages/farm-protocol/src/configuration-common.ts'
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
export type ConfigurationRegistrationResult =
  | {
      ok: true
      assignmentId: string
      receiptSha256: string
      status: 'active'
      /** True when this exact receipt had been registered before (lost acknowledgement). */
      replayed: boolean
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
}) {
  const { store, registry } = input
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
          const existing = await tx.receipt(op.operation_id)
          if (existing)
            return existing.receipt_sha256 === receiptSha256
              ? {
                  ok: true as const,
                  assignmentId: existing.assignment_id,
                  receiptSha256,
                  status: 'active' as const,
                  replayed: true,
                }
              : configurationFailure('conflict')
          const registered = await tx.registerReceipt({
            operation_id: op.operation_id,
            receipt_sha256: receiptSha256,
            receipt_wire: parsed.data.request.receiptWire,
            farm_id: a.farm_id,
            agent_id: a.agent_id,
            account_id: a.account_id,
            printer_key: receipt.target.device_id,
            committed_revision: committedRevision,
            registered_at: now,
          })
          return registered.ok
            ? {
                ok: true as const,
                assignmentId: BrowserDeviceUuid.parse(registered.assignmentId),
                receiptSha256,
                status: 'active' as const,
                replayed: false,
              }
            : configurationFailure('conflict')
        })
      })
    },
  })
}
export type ConfigurationRegistrationService = ReturnType<
  typeof createConfigurationRegistrationService
>
