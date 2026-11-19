import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { z } from 'zod'

/** Scalar machine fields that a detected state may report and an owner may override. */
export const MACHINE_PROFILE_FIELDS = [
  'model',
  'nozzleDiameterMm',
  'bedSizeXMm',
  'bedSizeYMm',
  'bedSizeZMm',
  'maxHotendTemperatureCelsius',
  'maxBedTemperatureCelsius',
  'kinematics',
] as const
export type MachineProfileField = (typeof MACHINE_PROFILE_FIELDS)[number]

export interface MachineProfileValues {
  model: string | null
  nozzleDiameterMm: number | null
  bedSizeXMm: number | null
  bedSizeYMm: number | null
  bedSizeZMm: number | null
  maxHotendTemperatureCelsius: number | null
  maxBedTemperatureCelsius: number | null
  kinematics: string | null
}

/** Owner-written part of a profile: field overrides plus free-form metadata. */
export interface MachineProfileOverride extends MachineProfileValues {
  compatibleModels: string[]
  notes: string | null
}

export interface MachineProfileAudit {
  updatedBy: string
  updatedAt: number
}

export type FieldSource = 'override' | 'detected' | 'unknown'

export interface EffectiveMachineProfile {
  values: MachineProfileValues
  sources: Record<MachineProfileField, FieldSource>
  compatibleModels: string[]
  notes: string | null
}

export const EMPTY_OVERRIDE: Readonly<MachineProfileOverride> = Object.freeze({
  model: null,
  nozzleDiameterMm: null,
  bedSizeXMm: null,
  bedSizeYMm: null,
  bedSizeZMm: null,
  maxHotendTemperatureCelsius: null,
  maxBedTemperatureCelsius: null,
  kinematics: null,
  compatibleModels: [],
  notes: null,
})

const EMPTY_DETECTED: Readonly<MachineProfileValues> = Object.freeze({
  model: null,
  nozzleDiameterMm: null,
  bedSizeXMm: null,
  bedSizeYMm: null,
  bedSizeZMm: null,
  maxHotendTemperatureCelsius: null,
  maxBedTemperatureCelsius: null,
  kinematics: null,
})

const noControl = (value: string) => !/[\p{Cc}\p{Cs}]/u.test(value)
const shortText = z.string().trim().min(1).max(64).refine(noControl).nullable()
const dimension = (max: number) =>
  z.number().finite().positive().max(max).nullable()

/** Strict body of an owner edit; every field is replaced, `null` clears an override. */
export const machineProfileEditSchema = z.strictObject({
  model: shortText,
  nozzleDiameterMm: dimension(10),
  bedSizeXMm: dimension(5000),
  bedSizeYMm: dimension(5000),
  bedSizeZMm: dimension(5000),
  maxHotendTemperatureCelsius: dimension(1000),
  maxBedTemperatureCelsius: dimension(1000),
  kinematics: shortText,
  compatibleModels: z
    .array(z.string().trim().min(1).max(64).refine(noControl))
    .max(16),
  notes: z.string().trim().min(1).max(1000).refine(noControl).nullable(),
})

/** Removes duplicate compatible models while keeping the owner's order. */
export function normalizeEdit(
  edit: z.infer<typeof machineProfileEditSchema>,
): MachineProfileOverride {
  return { ...edit, compatibleModels: [...new Set(edit.compatibleModels)] }
}

const firstValue = (record: Record<string, number> | undefined) => {
  if (!record) return null
  const preferred = record['0']
  if (preferred !== undefined) return preferred
  const keys = Object.keys(record).sort((a, b) => Number(a) - Number(b))
  return keys.length ? (record[keys[0]!] ?? null) : null
}

/**
 * Reads what the Connector detected from a stored latest-state snapshot.
 * An invalid or missing snapshot detects nothing instead of failing the read.
 */
export function detectedProfile(state: unknown): MachineProfileValues {
  const parsed = PrinterState.safeParse(state)
  if (!parsed.success) return { ...EMPTY_DETECTED }
  const { machine, identity } = parsed.data
  const hotend = machine?.maxHotendTemperatureCelsius
  const hotendValues = hotend ? Object.values(hotend) : []
  return {
    model: machine?.model ?? identity?.model ?? null,
    nozzleDiameterMm: firstValue(machine?.nozzleDiameterMm),
    bedSizeXMm: machine?.bedSizeMm?.x ?? null,
    bedSizeYMm: machine?.bedSizeMm?.y ?? null,
    bedSizeZMm: machine?.bedSizeMm?.z ?? null,
    maxHotendTemperatureCelsius: hotendValues.length
      ? (hotend?.['0'] ?? Math.max(...hotendValues))
      : null,
    maxBedTemperatureCelsius: machine?.maxBedTemperatureCelsius ?? null,
    kinematics: machine?.kinematics ?? null,
  }
}

/** The effective profile is the owner override over the detected value, field by field. */
export function mergeEffectiveProfile(
  detected: MachineProfileValues | null | undefined,
  override: MachineProfileOverride | null | undefined,
): EffectiveMachineProfile {
  const base = detected ?? EMPTY_DETECTED
  const owner = override ?? EMPTY_OVERRIDE
  const values: Record<string, string | number | null> = {}
  const sources: Record<string, FieldSource> = {}
  for (const field of MACHINE_PROFILE_FIELDS) {
    const overridden = owner[field]
    const found = base[field]
    values[field] = overridden ?? found ?? null
    sources[field] =
      overridden !== null && overridden !== undefined
        ? 'override'
        : found !== null && found !== undefined
          ? 'detected'
          : 'unknown'
  }
  return {
    values: values as unknown as MachineProfileValues,
    sources: sources as Record<MachineProfileField, FieldSource>,
    compatibleModels: [...owner.compatibleModels],
    notes: owner.notes,
  }
}

export interface MachineProfileView {
  assignmentId: string
  detected: MachineProfileValues
  override: MachineProfileOverride
  effective: EffectiveMachineProfile
  updatedBy: string | null
  updatedAt: number | null
}

/** Builds the response shape shared by the read route and the library/replay list. */
export function machineProfileView(
  assignmentId: string,
  detected: MachineProfileValues,
  stored: (MachineProfileOverride & MachineProfileAudit) | null,
): MachineProfileView {
  const owner: MachineProfileOverride = stored
    ? {
        ...EMPTY_OVERRIDE,
        ...stored,
        compatibleModels: [...stored.compatibleModels],
      }
    : { ...EMPTY_OVERRIDE, compatibleModels: [] }
  return {
    assignmentId,
    detected,
    override: owner,
    effective: mergeEffectiveProfile(detected, owner),
    updatedBy: stored?.updatedBy ?? null,
    updatedAt: stored?.updatedAt ?? null,
  }
}
