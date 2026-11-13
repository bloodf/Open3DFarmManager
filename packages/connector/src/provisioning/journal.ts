import { join } from 'node:path'
import { z } from 'zod'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import {
  configurationDigest,
  configurationOpaqueId,
} from '../../../farm-protocol/src/configuration-common.ts'
import { ConfigurationErrorCode } from '../../../farm-protocol/src/configuration-frames.ts'
import { SignedConfigurationReceipt } from '../../../farm-protocol/src/configuration-receipt.ts'
import { ConfigurationTarget } from '../../../farm-protocol/src/configuration-target.ts'
import {
  ensurePrivateDirectory,
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomic,
} from './private-fs.ts'

/**
 * Durable provisioning journal. One private file per operation plus one state
 * file (revision, active operation, replay and request ledgers). Facts are
 * persisted before the effect they describe; an interrupted transitional
 * stage is never promoted to success without local or receipt evidence.
 */
export const MAX_OPERATIONS = 32
export const MAX_LEDGER = 48
const revision = z.number().int().nonnegative().max(2_147_483_646)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const OperationStage = z.enum([
  'accepted',
  'discovering',
  'create-pending',
  'compensating',
  'prepared',
  'committing',
  'local-committed',
  'inventory-confirmed',
  'recovery-required',
  'cancelled',
  'failed',
])
export type OperationStage = z.infer<typeof OperationStage>
/** Stages that can only be observed after the holder stopped mid-step. */
export const TRANSITIONAL_STAGES: readonly OperationStage[] = [
  'accepted',
  'discovering',
  'create-pending',
  'compensating',
  'committing',
]
export const RecoveryCause = z.enum([
  'create-outcome-unknown',
  'rollback-failed',
  'journal-inconsistent',
])
export type RecoveryCause = z.infer<typeof RecoveryCause>

const OperationBinding = z.strictObject({
  account_id: z.string().min(1).max(128),
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
  credential_jti: BrowserDeviceUuid,
  transport_id: BrowserDeviceUuid,
})
export type OperationBinding = z.infer<typeof OperationBinding>

export const ObservedPrinter = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(128),
  device_id: configurationOpaqueId,
  ip: z.ipv4(),
  model: z.string().max(128).nullable(),
  firmware: z.string().max(128).nullable(),
  /** `created`: this operation's create response proved it. Only those may be compensated. */
  ownership: z.enum(['created', 'preexisting']),
})
export type ObservedPrinter = z.infer<typeof ObservedPrinter>

export const CommitPlan = z.strictObject({
  assignment_id: BrowserDeviceUuid,
  printer_key: z.string().min(1).max(128),
  credential_file: z.string().min(1).max(4096),
  committed_revision: revision.min(1),
})
export type CommitPlan = z.infer<typeof CommitPlan>

export const OperationRecord = z.strictObject({
  v: z.literal(1),
  operation_id: BrowserDeviceUuid,
  binding: OperationBinding,
  target: ConfigurationTarget,
  target_sha256: configurationDigest,
  expected_revision: revision,
  bridge_instance_id: configurationOpaqueId.nullable(),
  stage: OperationStage,
  before_ids: z.array(z.string().max(128)).max(256).nullable(),
  printer: ObservedPrinter.nullable(),
  failure: ConfigurationErrorCode.nullable(),
  recovery: RecoveryCause.nullable(),
  plan: CommitPlan.nullable(),
  prepared: SignedConfigurationReceipt.nullable(),
  latest: SignedConfigurationReceipt.nullable(),
  created_at: time,
  updated_at: time,
})
export type OperationRecord = z.infer<typeof OperationRecord>

export const JournalState = z.strictObject({
  v: z.literal(1),
  revision,
  active: BrowserDeviceUuid.nullable(),
  operations: z.array(BrowserDeviceUuid).max(MAX_OPERATIONS),
  /** `capability_id:admission_nonce`, consumed exactly once. */
  consumed: z.array(z.string().max(160)).max(MAX_LEDGER),
  /** `request_id:frame_digest`; a reused request id must carry the same frame. */
  requests: z.array(z.string().max(160)).max(MAX_LEDGER),
})
export type JournalState = z.infer<typeof JournalState>

const EMPTY: JournalState = Object.freeze({
  v: 1,
  revision: 0,
  active: null,
  operations: [],
  consumed: [],
  requests: [],
}) as JournalState

export function createJournal(directory: string) {
  ensurePrivateDirectory(directory)
  const operationsDirectory = join(directory, 'operations')
  ensurePrivateDirectory(operationsDirectory)
  const statePath = join(directory, 'state.json')
  const operationPath = (id: string) =>
    join(operationsDirectory, `${BrowserDeviceUuid.parse(id)}.json`)
  return Object.freeze({
    readState(): JournalState {
      const raw = readPrivateJson(statePath)
      return raw === null ? EMPTY : JournalState.parse(raw)
    },
    writeState(state: JournalState): void {
      writePrivateJsonAtomic(statePath, JournalState.parse(state))
    },
    readOperation(id: string): OperationRecord | null {
      const raw = readPrivateJson(operationPath(id))
      if (raw === null) return null
      const record = OperationRecord.parse(raw)
      if (record.operation_id !== id) throw new Error('Journal mismatch')
      return record
    },
    writeOperation(record: OperationRecord): void {
      writePrivateJsonAtomic(
        operationPath(record.operation_id),
        OperationRecord.parse(record),
      )
    },
    removeOperation(id: string): void {
      removePrivateFile(operationPath(id))
    },
  })
}
export type ProvisioningJournal = ReturnType<typeof createJournal>

/** Bounded append keeping the most recent entries. */
export function appendBounded(
  list: readonly string[],
  entry: string,
): string[] {
  return [...list.filter((value) => value !== entry), entry].slice(-MAX_LEDGER)
}
