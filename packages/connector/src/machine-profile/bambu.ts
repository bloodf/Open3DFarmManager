import { MachineProfile } from '../../../farm-protocol/src/machine-profile.ts'
import {
  BAMBU_MAX_AMS_UNITS,
  bambuAmsSlotCount,
  bambuAmsUnitId,
} from '../bambu/ams.ts'

/*
 * Dual-nozzle and filament-unit fields: bambulab/BambuStudio (AGPL-3.0),
 * commit 23a33758933e712c6041e1f8f135f7d6b50004aa, src/slic3r/GUI/DeviceCore/:
 * - DevExtruderSystem.cpp `ExtderSystemParser::ParseV2_0`: bits 0-3 of
 *   `device.extruder.state` count the extruders.
 * - DevNozzleSystem.cpp `DevNozzleSystemParser::ParseV2_0`:
 *   `device.nozzle.info[]`; low nibble of `id` is the nozzle, a next nibble of
 *   1 marks a nozzle stored on a rack.
 * - DevFilaSystem.cpp `DevFilaSystemParser::ParseAmsInfo` and DevDefs.h
 *   `DevAmsType`: hex `info` of a unit, bits 0-3 type, bits 8-11 extruder.
 */

type Unit = NonNullable<MachineProfile['materialUnits']>[number]
const KINDS: Readonly<Record<number, Unit['kind']>> = {
  1: 'ams',
  2: 'ams-lite',
  3: 'ams-2-pro',
  4: 'ams-ht',
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

function diameterMm(raw: unknown): number | undefined {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d{1,2}(?:\.\d{1,3})?$/.test(raw)
        ? Number(raw)
        : undefined
  return value !== undefined &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 10
    ? value
    : undefined
}

function toolCount(print: Record<string, unknown>): number | undefined {
  const state = object(object(print.device)?.extruder)?.state
  if (typeof state !== 'number' || !Number.isSafeInteger(state))
    return undefined
  const count = state & 0xf
  return count === 1 || count === 2 ? count : undefined
}

function toolDiameters(
  print: Record<string, unknown>,
  count: number,
): number[] | undefined {
  const info = object(object(print.device)?.nozzle)?.info
  if (!Array.isArray(info)) return undefined
  const found = new Map<number, number>()
  for (const raw of info.slice(0, 16)) {
    const nozzle = object(raw)
    const id = nozzle?.id
    if (typeof id !== 'number' || ((id >> 4) & 0xf) === 1) continue
    const diameter = diameterMm(nozzle?.diameter)
    if (diameter !== undefined) found.set(id & 0xf, diameter)
  }
  const diameters = Array.from({ length: count }, (_, tool) => found.get(tool))
  return diameters.every((value) => value !== undefined)
    ? (diameters as number[])
    : undefined
}

function materialUnit(raw: unknown): Unit | undefined {
  const unit = object(raw)
  const id = bambuAmsUnitId(unit?.id)
  const info = unit?.info
  if (
    id === undefined ||
    typeof info !== 'string' ||
    !/^[0-9a-f]{1,16}$/i.test(info)
  )
    return undefined
  const word = BigInt(`0x${info}`)
  const kind = KINDS[Number(word & 0xfn)]
  if (!kind) return undefined
  const tool = Number((word >> 8n) & 0xfn)
  return {
    id,
    kind,
    slots: bambuAmsSlotCount(id),
    ...(tool <= 1 ? { tool } : {}),
  }
}

/**
 * Folds one report into the known profile. Only what the printer reports is
 * kept: bed size, temperature limits and the model name stay unknown, and a
 * filament unit without its type word is not described.
 */
export function mergeBambuMachineProfile(
  previous: MachineProfile | undefined,
  report: unknown,
): MachineProfile | undefined {
  const print = object(object(report)?.print)
  if (!print) return previous
  const next: MachineProfile = { ...previous }
  const count = toolCount(print)
  if (count !== undefined && count !== next.toolCount) {
    next.toolCount = count
    if (next.nozzleDiametersMm?.length !== count) delete next.nozzleDiametersMm
  }
  const tools = next.toolCount ?? 1
  const perTool = toolDiameters(print, tools)
  // The single legacy value cannot be assigned to one of two nozzles.
  const legacy = tools === 1 ? diameterMm(print.nozzle_diameter) : undefined
  if (perTool) next.nozzleDiametersMm = perTool
  else if (legacy !== undefined) next.nozzleDiametersMm = [legacy]
  const list = object(print.ams)?.ams
  if (Array.isArray(list)) {
    const units = list.slice(0, BAMBU_MAX_AMS_UNITS).flatMap((raw): Unit[] => {
      const unit =
        materialUnit(raw) ??
        previous?.materialUnits?.find(
          (known) => known.id === bambuAmsUnitId(object(raw)?.id),
        )
      return unit ? [unit] : []
    })
    if (units.length) next.materialUnits = units
    else delete next.materialUnits
  }
  const parsed = MachineProfile.safeParse(next)
  return parsed.success ? parsed.data : undefined
}

/** The profile one report describes on its own. */
export function parseBambuMachineProfile(
  report: unknown,
): MachineProfile | undefined {
  return mergeBambuMachineProfile(undefined, report)
}
