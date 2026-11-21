/**
 * Wire shapes of upstream `Vendor` and `Filament` (response_model_exclude_none:
 * null fields are omitted, `extra` and `tags` are always present), plus the
 * farm-scoped loading the find endpoints share.
 */
import type {
  PageInput,
  Result,
  Spool,
  SpoolFilament,
  SpoolRecordId,
  SpoolVendor,
} from '../scope.ts'
import { spoolmanDateTime } from './compat.ts'

const PAGE = 500
/** Upper bound on one farm's records scanned by a find request. */
export const MAX_SCAN = 20_000

/** Read every record of one kind for this farm, in ascending id order. */
export async function loadAll<T extends { id: SpoolRecordId }>(
  list: (page: PageInput) => Promise<Result<T[]>>,
): Promise<Result<T[]>> {
  const rows: T[] = []
  let afterId = 0
  for (;;) {
    const page = await list({ limit: PAGE, afterId })
    if (!page.ok) return page
    rows.push(...page.value)
    if (page.value.length < PAGE) return { ok: true, value: rows }
    if (rows.length >= MAX_SCAN) return { ok: false, reason: 'limit' }
    afterId = page.value[page.value.length - 1]!.id
  }
}

const present = (entries: [string, unknown][]) =>
  Object.fromEntries(entries.filter(([, v]) => v !== null && v !== undefined))

/** Only JSON-encoded string values are extra-field values. */
export const extraOf = (extra: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(extra ?? {}).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>

export function vendorJson(vendor: SpoolVendor): Record<string, unknown> {
  return present([
    ['id', vendor.id],
    ['registered', spoolmanDateTime(vendor.registeredAt)],
    ['name', vendor.name],
    ['comment', vendor.comment],
    ['empty_spool_weight', vendor.emptySpoolWeight],
    ['external_id', vendor.externalId],
    ['extra', extraOf(vendor.extra)],
  ])
}

const HEX = /^[0-9A-F]+$/

/** Upstream `_sanitize_color_hex`: uppercase, no `#`, else dropped. */
export function sanitizeColor(value: string | null): string | null {
  if (!value) return null
  const color = value.toUpperCase().replace(/^#/, '')
  return (color.length === 6 || color.length === 8) && HEX.test(color)
    ? color
    : null
}

export function sanitizeMultiColor(value: string | null): string | null {
  if (!value) return null
  const colors = value
    .split(',')
    .map(sanitizeColor)
    .filter((c): c is string => c !== null)
  return colors.length < 2 ? null : colors.join(',')
}

export function filamentJson(
  filament: SpoolFilament,
  vendor: SpoolVendor | null,
): Record<string, unknown> {
  return present([
    ['id', filament.id],
    ['registered', spoolmanDateTime(filament.registeredAt)],
    ['name', filament.name],
    ['vendor', vendor ? vendorJson(vendor) : null],
    ['material', filament.material],
    ['price', filament.price],
    ['density', filament.density],
    ['diameter', filament.diameter],
    ['weight', filament.weight],
    ['spool_weight', filament.spoolWeight],
    ['article_number', filament.articleNumber],
    ['comment', filament.comment],
    ['settings_extruder_temp', filament.settingsExtruderTemp],
    ['settings_bed_temp', filament.settingsBedTemp],
    ['color_hex', sanitizeColor(filament.colorHex)],
    ['multi_color_hexes', sanitizeMultiColor(filament.multiColorHexes)],
    ['multi_color_direction', filament.multiColorDirection],
    ['external_id', filament.externalId],
    ['extra', extraOf(filament.extra)],
    // NFC/RFID tag links are served by the tag module; none exist without it.
    ['tags', []],
  ])
}

/** Upstream `spoolman.math.weight_from_length`: mm -> g. */
export function weightFromLength(
  length: number,
  diameter: number,
  density: number,
): number {
  const volumeMm3 = length * Math.PI * (diameter / 2) ** 2
  const volumeCm3 = volumeMm3 / 1000
  return density * volumeCm3
}

/** Upstream `spoolman.math.length_from_weight`: g -> mm. */
export function lengthFromWeight(
  weight: number,
  diameter: number,
  density: number,
): number {
  const volumeCm3 = weight / density
  const volumeMm3 = volumeCm3 * 1000
  return volumeMm3 / (Math.PI * (diameter / 2) ** 2)
}

export function spoolJson(
  spool: Spool,
  filament: SpoolFilament,
  vendor: SpoolVendor | null,
): Record<string, unknown> {
  let remainingWeight: number | null = null
  let remainingLength: number | null = null
  const baseWeight =
    spool.initialWeight !== null ? spool.initialWeight : filament.weight
  if (baseWeight !== null) {
    remainingWeight = Math.max(baseWeight - spool.usedWeight, 0)
    remainingLength = lengthFromWeight(
      remainingWeight,
      filament.diameter,
      filament.density,
    )
  }
  const usedLength = lengthFromWeight(
    spool.usedWeight,
    filament.diameter,
    filament.density,
  )
  return present([
    ['id', spool.id],
    ['registered', spoolmanDateTime(spool.registeredAt)],
    [
      'first_used',
      spool.firstUsedAt !== null ? spoolmanDateTime(spool.firstUsedAt) : null,
    ],
    [
      'last_used',
      spool.lastUsedAt !== null ? spoolmanDateTime(spool.lastUsedAt) : null,
    ],
    ['filament', filamentJson(filament, vendor)],
    ['price', spool.price],
    ['remaining_weight', remainingWeight],
    ['initial_weight', spool.initialWeight],
    ['spool_weight', spool.spoolWeight],
    ['used_weight', spool.usedWeight],
    ['remaining_length', remainingLength],
    ['used_length', usedLength],
    ['location', spool.location],
    ['lot_nr', spool.lotNr],
    ['comment', spool.comment],
    ['archived', spool.archived],
    ['extra', extraOf(spool.extra)],
    // NFC/RFID tag links are served by the tag module; none exist without it.
    ['tags', []],
  ])
}

export const notFound = (kind: 'vendor' | 'filament' | 'spool', id: number) =>
  `No ${kind} with ID ${id} found.`
