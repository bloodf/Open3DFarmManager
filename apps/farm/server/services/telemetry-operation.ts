import { createHash } from 'node:crypto'
import {
  parseBoundedJson,
  TELEMETRY_BATCH_JSON_LIMITS,
  TelemetryBatch,
  telemetryPrinterKey,
  type TelemetryEvent,
} from '@open3dfarmmanager/farm-protocol'
import { TELEMETRY_OPERATION_PATH } from '../../../../packages/farm-protocol/src/telemetry-proof.ts'
/** Immutable request snapshot, created before any await; no caller-supplied authorization set. */
export interface TelemetryOperation {
  kind: 'telemetry'
  method: 'POST'
  path: typeof TELEMETRY_OPERATION_PATH
  bodyHash: string
  bodyBytes: number
  records: TelemetryEvent[]
  inventorySnapshots: Extract<TelemetryEvent, { kind: 'inventory-snapshot' }>[]
}
export function prepareTelemetryOperation(input: unknown): TelemetryOperation {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 1 ||
    input.byteLength > TELEMETRY_BATCH_JSON_LIMITS.maxBytes
  )
    throw new Error('Invalid telemetry body')
  const bytes = Buffer.from(input)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const records = TelemetryBatch.parse(
    parseBoundedJson(text, TELEMETRY_BATCH_JSON_LIMITS),
  )
  for (const record of records) {
    const key = telemetryPrinterKey(record)
    if (key === null) continue
    if (
      key.includes('\0') ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        key,
      )
    )
      throw new Error('Invalid telemetry printer key')
  }
  return {
    kind: 'telemetry',
    method: 'POST',
    path: TELEMETRY_OPERATION_PATH,
    bodyHash: createHash('sha256').update(bytes).digest('base64url'),
    bodyBytes: bytes.byteLength,
    records,
    inventorySnapshots: records.filter(
      (
        record,
      ): record is Extract<TelemetryEvent, { kind: 'inventory-snapshot' }> =>
        record.kind === 'inventory-snapshot',
    ),
  }
}
