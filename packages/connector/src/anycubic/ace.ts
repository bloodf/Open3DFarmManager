// Kobra and ACE Pro slot reports as the farm's material observations.
// Original code; behaviour sources (no code copied):
// - kobracontrol@ed298ff44f48a5ed2db0ac08e7e19243d542e14c: src/kobracontrol/ace.py
//   (box -1 is the spool holder, ids 0..3 are ACE units, three holder
//   positions beside an ACE, `rfid`/`sku`), src/kobracontrol/kobra.py
//   (partial reports merge) and tests/kobra_captures.py (field shapes).
// - spooler@911dc7efa8d2a6c24b445170d9af34f28dbb9658: plugin/spooler/anycubic.py
//   (status 0 or no type is empty, 100 percent is no reading, `extfilbox` is
//   the external spool).
import { boundPrinterString } from '@open3dfarmmanager/farm-protocol'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'

export type AnycubicMaterial = NonNullable<PrinterState['materials']>[number]

const EXTERNAL_SLOT = 'external'
/** The protocol's `materials` bound. */
const MAX_MATERIALS = 17

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const integer = (value: unknown, min: number, max: number) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max
    ? value
    : undefined

const label = (value: unknown) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= 64 ? boundPrinterString(text) : undefined
}

function colorHex(value: unknown) {
  if (!Array.isArray(value) || value.length < 3) return undefined
  const rgb = value.slice(0, 3)
  return rgb.every((channel) => integer(channel, 0, 255) !== undefined)
    ? Buffer.from([...(rgb as number[]), 255])
        .toString('hex')
        .toUpperCase()
    : undefined
}

/**
 * The tag identity the slot reports. Neither field is documented as unique to
 * one physical spool, so nothing may be bound from it here.
 */
function rfidIdentity(slot: Record<string, unknown>) {
  const sku = label(slot.sku)
  const raw = slot.rfid
  const tag =
    typeof raw === 'number'
      ? Number.isSafeInteger(raw) && raw > 0
        ? String(raw)
        : undefined
      : label(raw)
  return sku || tag
    ? { ...(tag ? { tag } : {}), ...(sku ? { sku } : {}) }
    : undefined
}

function slotMaterial(
  slot: Record<string, unknown>,
  name: string,
): AnycubicMaterial {
  const empty =
    slot.status === 0 || (typeof slot.type === 'string' && !slot.type.trim())
  const percent = slot.consumables_percent
  // 100 is what the printer answers for a spool it cannot measure. An empty
  // slot keeps only the printer's own 0; a missing value is never made 0.
  const remaining =
    typeof percent === 'number' &&
    percent >= 0 &&
    percent < 100 &&
    (!empty || percent === 0)
      ? percent
      : undefined
  const material = empty ? undefined : label(slot.type)
  const color = empty ? undefined : colorHex(slot.color)
  const rfid = empty ? undefined : rfidIdentity(slot)
  return {
    slot: name,
    ...(material ? { materialType: material } : {}),
    ...(color ? { colorHex: color } : {}),
    ...(remaining !== undefined ? { remainingPercent: remaining } : {}),
    ...(rfid ? { rfid } : {}),
  }
}

/**
 * Slots of a `multi_color_box` list, named `<box id>:<slot index>`. An empty
 * list means the printer has no boxes; `undefined` means the report says
 * nothing about slots (drying or feed state only) and changes nothing.
 */
export function anycubicBoxMaterials(
  value: unknown,
  options: { readyStatusIsActive?: boolean } = {},
): AnycubicMaterial[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MATERIALS) return undefined
  const materials: AnycubicMaterial[] = []
  for (const rawBox of value) {
    const box = object(rawBox)
    const id = integer(box.id, -1, 3)
    if (id === undefined || !Array.isArray(box.slots)) continue
    const slots = box.slots.slice(0, 4).map(object)
    // Position stands in only when no slot of the box carries an index.
    const positional = slots.every((slot) => slot.index === undefined)
    const loaded = integer(box.loaded_slot, -1, 3)
    slots.forEach((slot, position) => {
      const index = positional ? position : integer(slot.index, 0, 3)
      if (index === undefined) return
      const status = integer(slot.status, 0, Number.MAX_SAFE_INTEGER)
      const active =
        loaded !== undefined
          ? index === loaded
          : options.readyStatusIsActive && status !== undefined
            ? status === 5
            : undefined
      materials.push({
        ...slotMaterial(slot, `${id}:${index}`),
        ...(active !== undefined ? { active } : {}),
      })
    })
  }
  return materials.length || !value.length ? materials : undefined
}

/** The `data` of an `extfilbox` report: one external spool. */
export function anycubicExternalMaterial(
  value: unknown,
): AnycubicMaterial | undefined {
  const data = object(value)
  return ['type', 'color', 'status', 'consumables_percent'].some(
    (field) => data[field] !== undefined,
  )
    ? slotMaterial(data, EXTERNAL_SLOT)
    : undefined
}

/**
 * Applies one report to the known slots. Reports may name only some boxes or
 * slots, and the external spool arrives on its own; an empty list clears the
 * boxes and keeps the external spool.
 */
export function mergeAnycubicMaterials(
  previous: readonly AnycubicMaterial[] | undefined,
  incoming: readonly AnycubicMaterial[],
): AnycubicMaterial[] {
  const slots = new Map<string, AnycubicMaterial>()
  for (const material of previous ?? [])
    if (incoming.length || material.slot === EXTERNAL_SLOT)
      slots.set(material.slot, material)
  for (const material of incoming) {
    const active = material.active ?? slots.get(material.slot)?.active
    slots.set(material.slot, {
      ...material,
      ...(active !== undefined ? { active } : {}),
    })
  }
  // Beside an ACE the holder's fourth inlet carries the ACE: not a spool.
  if ([...slots.keys()].some((name) => /^\d:/.test(name))) slots.delete('-1:3')
  const external = slots.get(EXTERNAL_SLOT)
  slots.delete(EXTERNAL_SLOT)
  return [
    ...[...slots.values()].slice(0, MAX_MATERIALS - (external ? 1 : 0)),
    ...(external ? [external] : []),
  ]
}
