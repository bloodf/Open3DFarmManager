import {
  parseBoundedJson,
  TelemetryBatch,
  telemetryPrinterKey,
  type TelemetryEvent,
} from '@open3dfarmmanager/farm-protocol'

/** Trusted middleware input, never decoded from the submitted body. Not proof of authentication itself. */
export interface AgentIngestionContext {
  farmId: string
  agentId: string
  printerKeys: ReadonlySet<string>
}
export interface TelemetryEventStore {
  /** Atomic, durable, scoped insert/dedup; conflicting reuse of an ID rejects the entire batch. */
  commitBatch(
    scope: { farmId: string; agentId: string },
    records: readonly TelemetryEvent[],
  ): Promise<'committed' | 'conflict'>
}
export type IngestionResult =
  | { ok: true; acceptedEventIds: string[] }
  | {
      ok: false
      reason:
        | 'unauthorized'
        | 'invalid-batch'
        | 'forbidden-printer'
        | 'conflict'
        | 'storage-unavailable'
    }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Internal service only. No route is exposed; authentication and request stream limits are prerequisites. */
export async function ingestTelemetry(
  body: string,
  context: AgentIngestionContext | null,
  store: TelemetryEventStore,
): Promise<IngestionResult> {
  let scope: { farmId: string; agentId: string }
  let allowed: Set<string>
  try {
    if (
      !context ||
      typeof context.farmId !== 'string' ||
      typeof context.agentId !== 'string' ||
      !uuid.test(context.farmId) ||
      !uuid.test(context.agentId) ||
      !(context.printerKeys instanceof Set) ||
      context.printerKeys.size > 1000 ||
      [...context.printerKeys].some(
        (key) => typeof key !== 'string' || !key.length || key.length > 128,
      )
    )
      return { ok: false, reason: 'unauthorized' }
    scope = { farmId: context.farmId, agentId: context.agentId }
    allowed = new Set(context.printerKeys)
  } catch {
    return { ok: false, reason: 'unauthorized' }
  }
  let records: TelemetryEvent[]
  try {
    records = TelemetryBatch.parse(
      parseBoundedJson(body, {
        maxBytes: 64 * 1024,
        maxDepth: 5,
        maxValues: 2000,
        maxStringChars: 128,
      }),
    )
  } catch {
    return { ok: false, reason: 'invalid-batch' }
  }
  if (records.some((record) => !allowed.has(telemetryPrinterKey(record))))
    return { ok: false, reason: 'forbidden-printer' }
  const acceptedEventIds = records.map((record) => record.eventId)
  try {
    const result = await store.commitBatch(scope, records)
    if (result === 'conflict') return { ok: false, reason: 'conflict' }
    if (result !== 'committed')
      return { ok: false, reason: 'storage-unavailable' }
  } catch {
    return { ok: false, reason: 'storage-unavailable' }
  }
  return { ok: true, acceptedEventIds }
}
