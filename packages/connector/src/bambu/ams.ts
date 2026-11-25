/**
 * AMS addressing and report merging, standard AMS and AMS HT.
 *
 * Wire facts come from bambulab/BambuStudio (AGPL-3.0) at commit
 * 23a33758933e712c6041e1f8f135f7d6b50004aa; this is original code, nothing is
 * copied. Under src/slic3r/GUI/:
 * - DeviceCore/DevDefs.h: unit types, virtual tray ids 255 (main) and
 *   254 (deputy).
 * - DeviceCore/DevFilaSystem.cpp `DevAms::GetTrayId`, `DevAms::IsExist`,
 *   `DevAms::GetSlotCount`: `tray_exist_bits` and `ams_exist_bits` positions.
 * - DeviceCore/DevFilaSystem.cpp `DevFilaSystemParser::ParseV1_0`,
 *   `ParseAmsInfo`, `ParseAmsTrayInfo`: a unit or tray missing from its list
 *   is removed, and a tray without identity fields is cleared.
 * - ../Utils/json_diff.cpp `diff2all`/`restore_objects`: incremental pushes
 *   merge objects key by key and replace arrays whole.
 * - DeviceCore/DevExtruderSystem.cpp: `tray_now`, and `snow` = unit id in
 *   bits 8-15, slot in bits 0-7.
 *
 * None of this has been observed on hardware by this project.
 */
import type { PrinterState } from '../../../farm-protocol/src/state.ts'

export type BambuMaterial = NonNullable<PrinterState['materials']>[number]

/** AMS HT units are numbered from 0x80 and hold one slot each. */
export const BAMBU_AMS_HT_FIRST_ID = 128
export const BAMBU_AMS_HT_LAST_ID = 135
/** Four 4-slot units plus eight AMS HT units. */
export const BAMBU_MAX_AMS_UNITS = 12
/** Matches the `PrinterState.materials` bound. */
export const BAMBU_MAX_MATERIALS = 17
const MAIN_VIRTUAL_ID = 255
const DEPUTY_VIRTUAL_ID = 254

export const isBambuAmsHt = (amsId: number) =>
  amsId >= BAMBU_AMS_HT_FIRST_ID && amsId <= BAMBU_AMS_HT_LAST_ID

function integer(value: unknown): number | undefined {
  const parsed =
    typeof value === 'string' && /^\d{1,10}$/.test(value)
      ? Number(value)
      : value
  return typeof parsed === 'number' && Number.isSafeInteger(parsed)
    ? parsed
    : undefined
}

export function bambuAmsUnitId(value: unknown): number | undefined {
  const id = integer(value)
  return id !== undefined && ((id >= 0 && id <= 3) || isBambuAmsHt(id))
    ? id
    : undefined
}

export const bambuAmsSlotCount = (amsId: number) =>
  isBambuAmsHt(amsId) ? 1 : 4

/**
 * Address of one global tray index (`tray_now`, and `target` of
 * `ams_change_filament`): 0-15 are unit*4+slot, 128-135 are AMS HT unit ids.
 */
export function bambuTrayAddress(
  index: number,
): { amsId: number; slotId: number } | undefined {
  if (!Number.isInteger(index)) return undefined
  if (index >= 0 && index <= 15) return { amsId: index >> 2, slotId: index & 3 }
  return isBambuAmsHt(index) ? { amsId: index, slotId: 0 } : undefined
}

const trayExistBit = (amsId: number, slotId: number) =>
  isBambuAmsHt(amsId)
    ? 16 + (amsId - BAMBU_AMS_HT_FIRST_ID) + slotId
    : amsId * 4 + slotId
const amsExistBit = (amsId: number) =>
  isBambuAmsHt(amsId) ? 4 + (amsId - BAMBU_AMS_HT_FIRST_ID) : amsId

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const bits = (value: unknown): bigint | undefined =>
  typeof value === 'string' && /^[0-9a-f]{1,16}$/i.test(value)
    ? BigInt(`0x${value}`)
    : undefined
const bitSet = (word: bigint, position: number) =>
  ((word >> BigInt(position)) & 1n) === 1n

const amsSlot = (amsId: number, slotId: number) => `ams:${amsId}:${slotId}`
function parseAmsSlot(slot: string) {
  const match = /^ams:(\d{1,3}):(\d)$/.exec(slot)
  return match
    ? { amsId: Number(match[1]), slotId: Number(match[2]) }
    : undefined
}

function virtualSlot(id: number): string | undefined {
  return id === MAIN_VIRTUAL_ID
    ? 'external'
    : id === DEPUTY_VIRTUAL_ID
      ? `external:${DEPUTY_VIRTUAL_ID}`
      : undefined
}

/** Slots being fed, or undefined when the report says nothing about it. */
function activeSlots(
  print: Record<string, unknown>,
): ReadonlySet<string> | undefined {
  // Newer firmware reports one current slot per extruder.
  const info = object(object(print.device).extruder).info
  if (Array.isArray(info)) {
    const slots = new Set<string>()
    let known = false
    for (const entry of info.slice(0, 2)) {
      const snow = integer(object(entry).snow)
      if (snow === undefined) continue
      known = true
      const amsId = (snow >> 8) & 0xff
      const slotId = snow & 0xff
      if (slotId === 0xff) continue
      const external = virtualSlot(amsId)
      if (external) slots.add(external)
      else if (bambuAmsUnitId(amsId) !== undefined)
        slots.add(amsSlot(amsId, isBambuAmsHt(amsId) ? 0 : slotId))
    }
    if (known) return slots
  }
  const now = integer(object(print.ams).tray_now)
  if (now === undefined) return undefined
  // Single-extruder firmware: 254 is the external spool, 255 is nothing.
  if (now === DEPUTY_VIRTUAL_ID) return new Set(['external'])
  if (now === MAIN_VIRTUAL_ID) return new Set()
  const address = bambuTrayAddress(now)
  return address ? new Set([amsSlot(address.amsId, address.slotId)]) : undefined
}

function material(raw: unknown, slot: string): BambuMaterial {
  const tray = object(raw)
  const item: BambuMaterial = { slot }
  if (
    typeof tray.tray_type === 'string' &&
    tray.tray_type.length > 0 &&
    tray.tray_type.length <= 64
  )
    item.materialType = tray.tray_type
  if (
    typeof tray.tray_color === 'string' &&
    /^[0-9a-f]{8}$/i.test(tray.tray_color)
  )
    item.colorHex = tray.tray_color.toUpperCase()
  if (
    typeof tray.remain === 'number' &&
    Number.isFinite(tray.remain) &&
    tray.remain >= 0 &&
    tray.remain <= 100
  )
    item.remainingPercent = tray.remain
  return item
}

/** AMS slots by unit and slot number, then the external spools. */
function bySlot(left: BambuMaterial, right: BambuMaterial) {
  const order = (item: BambuMaterial) => {
    const address = parseAmsSlot(item.slot)
    return address
      ? address.amsId * 4 + address.slotId
      : Number.MAX_SAFE_INTEGER
  }
  return order(left) - order(right)
}

/** Keeps external spools when a very large setup exceeds the protocol bound. */
function bounded(items: BambuMaterial[]): BambuMaterial[] {
  if (items.length <= BAMBU_MAX_MATERIALS) return items
  const external = items.filter((item) => !parseAmsSlot(item.slot))
  return [
    ...items
      .filter((item) => parseAmsSlot(item.slot))
      .slice(0, BAMBU_MAX_MATERIALS - external.length),
    ...external,
  ]
}

/** What one `print` report says about filament slots. */
export function decodeBambuAms(print: Record<string, unknown>) {
  const ams = object(print.ams)
  const amsExist = bits(ams.ams_exist_bits)
  const trayExist = bits(ams.tray_exist_bits)
  const active = activeSlots(print)
  const items = new Map<string, BambuMaterial>()
  const add = (item: BambuMaterial) => {
    if (!items.has(item.slot))
      items.set(
        item.slot,
        active ? { ...item, active: active.has(item.slot) } : item,
      )
  }
  /** Present when the report carries the unit list, which is then complete. */
  let units: Set<number> | undefined
  /** Units whose tray list is in this report, and is then complete. */
  const trayLists = new Set<number>()
  if (Array.isArray(ams.ams)) {
    units = new Set()
    for (const raw of ams.ams.slice(0, BAMBU_MAX_AMS_UNITS)) {
      const unit = object(raw)
      const amsId = bambuAmsUnitId(unit.id)
      if (amsId === undefined) continue
      if (amsExist !== undefined && !bitSet(amsExist, amsExistBit(amsId)))
        continue
      units.add(amsId)
      if (!Array.isArray(unit.tray)) continue
      trayLists.add(amsId)
      for (const rawTray of unit.tray.slice(0, bambuAmsSlotCount(amsId))) {
        const slotId = integer(object(rawTray).id)
        if (
          slotId === undefined ||
          slotId < 0 ||
          slotId >= bambuAmsSlotCount(amsId)
        )
          continue
        const slot = amsSlot(amsId, slotId)
        add(
          trayExist !== undefined &&
            !bitSet(trayExist, trayExistBit(amsId, slotId))
            ? { slot }
            : material(rawTray, slot),
        )
      }
    }
  }
  // `vir_slot` (two external spools) takes precedence over `vt_tray`.
  const virtual = Array.isArray(print.vir_slot) ? print.vir_slot : undefined
  if (virtual)
    for (const raw of virtual.slice(0, 2)) {
      const slot = virtualSlot(integer(object(raw).id) ?? -1)
      if (slot) add(material(raw, slot))
    }
  else if (
    print.vt_tray &&
    typeof print.vt_tray === 'object' &&
    !Array.isArray(print.vt_tray)
  )
    add(material(print.vt_tray, 'external'))
  return {
    materials: bounded([...items.values()]),
    units,
    trayLists,
    virtualList: virtual !== undefined,
    amsExist,
    trayExist,
    active,
  }
}

/**
 * Applies one report to the slots already known. Returns undefined when the
 * report says nothing about slots.
 */
export function applyBambuAmsReport(
  previous: readonly BambuMaterial[] | undefined,
  print: Record<string, unknown>,
): BambuMaterial[] | undefined {
  const update = decodeBambuAms(print)
  if (
    !update.materials.length &&
    !update.units &&
    !update.virtualList &&
    (!previous ||
      (!update.active &&
        update.amsExist === undefined &&
        update.trayExist === undefined))
  )
    return undefined
  const merged = new Map<string, BambuMaterial>()
  for (const item of previous ?? []) {
    const address = parseAmsSlot(item.slot)
    if (!address) {
      if (!update.virtualList) merged.set(item.slot, item)
      continue
    }
    const { amsId, slotId } = address
    if (update.units && !update.units.has(amsId)) continue
    if (update.trayLists.has(amsId)) continue
    if (
      update.amsExist !== undefined &&
      !bitSet(update.amsExist, amsExistBit(amsId))
    )
      continue
    merged.set(
      item.slot,
      update.trayExist !== undefined &&
        !bitSet(update.trayExist, trayExistBit(amsId, slotId))
        ? {
            slot: item.slot,
            ...(item.active === undefined ? {} : { active: item.active }),
          }
        : item,
    )
  }
  for (const item of update.materials)
    // `vt_tray` is an object, so its fields merge; list entries replace.
    merged.set(
      item.slot,
      parseAmsSlot(item.slot) || update.virtualList
        ? item
        : { ...merged.get(item.slot), ...item },
    )
  const items = [...merged.values()]
    .sort(bySlot)
    .map((item) =>
      update.active ? { ...item, active: update.active.has(item.slot) } : item,
    )
  return bounded(items)
}
