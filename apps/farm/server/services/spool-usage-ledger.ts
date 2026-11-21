import { randomUUID } from 'node:crypto'
import type { TransactionSql } from 'postgres'

/** Same event type as utils/webhooks/printer-alerts.ts (PRINTER_ALERT_RAISED). */
export const LOW_STOCK_EVENT = 'printer.alert.raised'

export interface JobUsageItem {
  tool: string
  grams?: number | undefined
  millimetres?: number | undefined
}
export interface ResolvedUsage {
  spoolId: number
  item: JobUsageItem
  diameter: number
  density: number
}

/** Volume of `mm` of filament times density (g/cm3); diameter in mm. */
export const gramsFromMillimetres = (
  mm: number,
  diameter: number,
  density: number,
) => (mm * Math.PI * (diameter / 2) ** 2 * density) / 1000

type SlotKind = 'printer' | 'ams' | 'toolhead'
/** Slots a connector tool name may refer to, most specific first. */
export function slotCandidates(
  tool: string,
): { kind: SlotKind; index: number }[] {
  const ams = /^(?:slot|ams)[-_:]?(\d{1,4})$/i.exec(tool)
  if (ams) return [{ kind: 'ams', index: Number(ams[1]) }]
  const head = /^(?:t|tool|extruder|toolhead)[-_:]?(\d{1,4})$/i.exec(tool)
  if (head) return [{ kind: 'toolhead', index: Number(head[1]) }]
  if (/^\d{1,4}$/.test(tool))
    return [
      { kind: 'toolhead', index: Number(tool) },
      { kind: 'ams', index: Number(tool) },
    ]
  return [
    { kind: 'printer', index: 0 },
    { kind: 'toolhead', index: 0 },
  ]
}

/**
 * Spool in each slot at job start. A tool that names no known slot (a single
 * material machine reports `unknown`) falls back to the only spool the printer
 * held at that moment.
 */
export async function resolveJobSlots(
  tx: TransactionSql,
  farm: string,
  printerId: string,
  startedAt: number,
  items: readonly JobUsageItem[],
): Promise<ResolvedUsage[]> {
  const active = await tx<
    {
      spoolId: number
      slotKind: SlotKind
      slotIndex: number
      diameter: number
      density: number
    }[]
  >`SELECT a.spool_id::float8 AS "spoolId", a.slot_kind AS "slotKind", a.slot_index AS "slotIndex", f.diameter, f.density
    FROM farm.spool_slot_assignments a
    JOIN farm.spools s ON s.farm_id=a.farm_id AND s.id=a.spool_id
    JOIN farm.spool_filaments f ON f.farm_id=s.farm_id AND f.id=s.filament_id
    WHERE a.farm_id=${farm}::uuid AND a.printer_id=${printerId}::uuid AND a.assigned_at<=${startedAt} AND (a.unassigned_at IS NULL OR a.unassigned_at>${startedAt})`
  const out: ResolvedUsage[] = []
  for (const item of items) {
    const hit =
      slotCandidates(item.tool)
        .map((c) =>
          active.find((a) => a.slotKind === c.kind && a.slotIndex === c.index),
        )
        .find((a) => a !== undefined) ??
      (item.tool === 'unknown' && active.length === 1 ? active[0] : undefined)
    if (hit)
      out.push({
        spoolId: hit.spoolId,
        item,
        diameter: hit.diameter,
        density: hit.density,
      })
  }
  return out
}

/**
 * Remaining grams across the filament's active spools, or null when no spool
 * has a known initial weight (own, else the filament's nominal weight).
 */
export async function filamentRemaining(
  tx: TransactionSql,
  farm: string,
  filamentId: number,
): Promise<number | null> {
  const rows = await tx<
    { remaining: number | null }[]
  >`SELECT sum(GREATEST(COALESCE(s.initial_weight, f.weight) - s.used_weight, 0))::float8 AS remaining
    FROM farm.spools s JOIN farm.spool_filaments f ON f.farm_id=s.farm_id AND f.id=s.filament_id
    WHERE s.farm_id=${farm}::uuid AND s.filament_id=${filamentId} AND NOT s.archived AND COALESCE(s.initial_weight, f.weight) IS NOT NULL`
  return rows[0]?.remaining ?? null
}

export interface SpoolEffect {
  filamentId: number
  remainingGrams: number | null
  thresholdGrams: number | null
  alerted: boolean
}

/**
 * Upstream "use" semantics: used_weight += delta (never below zero),
 * first_used_at set once, last_used_at moves forward. When the filament's
 * remaining total crosses its threshold downward, one alert is queued; it
 * cannot repeat until a restock lifts the total back above the threshold.
 * Callers hold the farm advisory lock.
 */
export async function adjustSpool(
  tx: TransactionSql,
  farm: string,
  spoolId: number,
  delta: number,
  at: number,
  lastUsedAt: number,
  printerId: string | null,
): Promise<SpoolEffect> {
  const found = await tx<
    { filamentId: number }[]
  >`SELECT filament_id::float8 AS "filamentId" FROM farm.spools WHERE farm_id=${farm}::uuid AND id=${spoolId}`
  const filamentId = found[0]?.filamentId
  if (filamentId === undefined) throw new Error('Spool vanished')
  const before = await filamentRemaining(tx, farm, filamentId)
  await tx`UPDATE farm.spools SET used_weight = GREATEST(used_weight + ${delta}::float8, 0.0),
      first_used_at = CASE WHEN ${delta}::float8 > 0 THEN COALESCE(first_used_at, ${at}::bigint) ELSE first_used_at END,
      last_used_at = CASE WHEN ${delta}::float8 > 0 THEN GREATEST(COALESCE(last_used_at, 0), ${lastUsedAt}::bigint) ELSE last_used_at END
    WHERE farm_id=${farm}::uuid AND id=${spoolId}`
  const after = await filamentRemaining(tx, farm, filamentId)
  const limits = await tx<
    { threshold: number | null; name: string | null; material: string | null }[]
  >`SELECT COALESCE(f.low_stock_threshold_grams, d.default_low_stock_threshold_grams) AS threshold, f.name, f.material
    FROM farm.spool_filaments f LEFT JOIN farm.spool_farm_settings d ON d.farm_id=f.farm_id
    WHERE f.farm_id=${farm}::uuid AND f.id=${filamentId}`
  const limit = limits[0]
  const threshold = limit?.threshold ?? null
  const crossed =
    threshold !== null &&
    before !== null &&
    after !== null &&
    before > threshold &&
    after <= threshold
  if (crossed && limit)
    await enqueueLowStock(tx, farm, printerId, {
      filamentId,
      name: limit.name,
      material: limit.material,
      remainingGrams: after,
      thresholdGrams: threshold,
    })
  return {
    filamentId,
    remainingGrams: after,
    thresholdGrams: threshold,
    alerted: crossed,
  }
}

/**
 * Queues `printer.alert.raised` (kind low-slot) on the signed-webhook outbox,
 * for subscriptions allowed on the farm and printer.
 */
async function enqueueLowStock(
  tx: TransactionSql,
  farm: string,
  printerId: string | null,
  stock: {
    filamentId: number
    name: string | null
    material: string | null
    remainingGrams: number
    thresholdGrams: number
  },
) {
  const printers = printerId
    ? await tx<
        { printerKey: string }[]
      >`SELECT printer_key AS "printerKey" FROM farm.printer_assignments WHERE farm_id=${farm}::uuid AND id=${printerId}::uuid`
    : []
  const label = stock.name ?? stock.material ?? `Filamento ${stock.filamentId}`
  const eventId = randomUUID()
  const event = {
    id: eventId,
    type: LOW_STOCK_EVENT,
    occurredAt: Date.now(),
    data: {
      farmId: farm,
      ...(printerId ? { printerId } : {}),
      ...(printers[0] ? { printerKey: printers[0].printerKey } : {}),
      alert: {
        id: `low-stock:${stock.filamentId}`,
        kind: 'low-slot',
        label: 'Estoque baixo',
        message: `${label}: restam ${Math.round(stock.remainingGrams)} g (limite ${Math.round(stock.thresholdGrams)} g).`,
      },
      filament: {
        id: stock.filamentId,
        name: stock.name,
        material: stock.material,
        remainingGrams: stock.remainingGrams,
        thresholdGrams: stock.thresholdGrams,
      },
    },
  }
  await tx`INSERT INTO farm.integration_webhook_outbox (subscription_id, event_id, farm_id, printer_id, body)
    SELECT w.id, ${eventId}::uuid, ${farm}::uuid, ${printerId}::uuid, ${tx.json(event)}
    FROM farm.integration_webhooks w
    WHERE ${LOW_STOCK_EVENT} = ANY(w.events)
      AND farm.integration_webhook_allowed(w.app_id, ${farm}::uuid, ${printerId}::uuid)`
}
