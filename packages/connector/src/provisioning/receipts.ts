import { randomUUID } from 'node:crypto'
import {
  CONFIGURATION_PROTOCOL,
  configurationOpaqueId,
} from '../../../farm-protocol/src/configuration-common.ts'
import {
  encodeConfigurationResponse,
  decodeConfigurationResponse,
  type ConfigurationErrorCode,
  type ConfigurationRequestFrame,
  type ConfigurationResponseFrame,
} from '../../../farm-protocol/src/configuration-frames.ts'
import {
  configurationReceiptHash,
  signConfigurationReceipt,
  type ConfigurationReceiptPhase,
  type SignedConfigurationReceipt,
} from '../../../farm-protocol/src/configuration-receipt.ts'
import type { OperationRecord } from './journal.ts'

/**
 * Either a nonextractable Ed25519 CryptoKey or an encapsulated identity signer
 * (ConnectorIdentity.configurationReceiptSigner) that never exposes its key.
 */
export type ReceiptSigner =
  | { fingerprint: string; receiptKey: CryptoKey }
  | {
      fingerprint: string
      signReceipt(claims: unknown): Promise<SignedConfigurationReceipt>
    }

const firmwareRe = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/
const modelRe = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/

/** Signs a receipt for durable facts only. The caller persists before returning it. */
export async function signOperationReceipt(
  signer: ReceiptSigner,
  op: OperationRecord,
  phase: ConfigurationReceiptPhase,
  issuedAt: number,
): Promise<SignedConfigurationReceipt> {
  const printer = op.printer
  if (!printer || !op.bridge_instance_id)
    throw new Error('Receipt requires an observed identity')
  configurationOpaqueId.parse(printer.device_id)
  const committed =
    phase === 'local-committed' || phase === 'inventory-confirmed'
  const prior =
    phase === 'prepared'
      ? null
      : op.latest
        ? await configurationReceiptHash(op.latest)
        : null
  const claims = {
    v: 1,
    purpose: 'configuration-receipt',
    protocol: CONFIGURATION_PROTOCOL,
    receipt_id: randomUUID(),
    account_id: op.binding.account_id,
    farm_id: op.binding.farm_id,
    agent_id: op.binding.agent_id,
    connector_fingerprint: signer.fingerprint,
    operation_id: op.operation_id,
    phase,
    target: {
      target_sha256: op.target_sha256,
      device_id: printer.device_id,
      bridge_instance_id: op.bridge_instance_id,
    },
    observed: {
      device_id: printer.device_id,
      model:
        printer.model !== null && modelRe.test(printer.model)
          ? printer.model
          : null,
      firmware:
        printer.firmware !== null && firmwareRe.test(printer.firmware)
          ? { status: 'observed', version: printer.firmware }
          : { status: 'unknown' },
      support: 'unqualified',
    },
    expected_revision: op.expected_revision,
    committed_revision: committed
      ? (op.plan?.committed_revision ?? null)
      : null,
    recovery_reason:
      phase === 'recovery-required'
        ? op.recovery === 'rollback-failed'
          ? 'rollback-failed'
          : 'journal-inconsistent'
        : null,
    prior_receipt_sha256: prior,
    issued_at: issuedAt,
  }
  return 'receiptKey' in signer
    ? signConfigurationReceipt(claims, signer.receiptKey)
    : signer.signReceipt(claims)
}

const validated = (frame: unknown): ConfigurationResponseFrame =>
  decodeConfigurationResponse(encodeConfigurationResponse(frame))

export function errorFrame(
  requestId: string | null,
  code: ConfigurationErrorCode,
): ConfigurationResponseFrame {
  return validated({
    v: 1,
    protocol: CONFIGURATION_PROTOCOL,
    type: 'error',
    request_id: requestId,
    code,
  })
}

export function unknownFrame(
  frame: ConfigurationRequestFrame,
  reason:
    | 'no-durable-record'
    | 'connector-restarted'
    | 'timeout-after-write'
    | 'cancel-acknowledged',
): ConfigurationResponseFrame {
  return validated({
    v: 1,
    protocol: CONFIGURATION_PROTOCOL,
    type: 'unknown',
    request_id: frame.request_id,
    operation_id: frame.operation_id,
    state: 'unknown',
    reason,
  })
}

export function resultFrame(
  frame: ConfigurationRequestFrame,
  receipt: SignedConfigurationReceipt,
): ConfigurationResponseFrame {
  return validated({
    v: 1,
    protocol: CONFIGURATION_PROTOCOL,
    type: 'result',
    request_id: frame.request_id,
    operation_id: frame.operation_id,
    state: receipt.phase,
    receipt,
  })
}
