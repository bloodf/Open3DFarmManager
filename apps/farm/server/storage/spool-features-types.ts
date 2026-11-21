/**
 * Row types for farm-scoped spool auxiliary APIs (#545) and farm features (#543),
 * matching migration 0089_spool_features_schema. Row types only.
 */
import type {
  SpoolEntityType,
  SpoolExtraFieldType,
  SpoolRecordId,
} from '../utils/spool-library/scope.ts'

export type SpoolSlotKind = 'printer' | 'ams' | 'toolhead'
export type SpoolUsageSource = 'telemetry' | 'manual' | 'api'
export type SpoolHumiditySource = 'ams' | 'manual'

/** Row in `farm.spool_library_settings`. */
export interface SpoolSettingRow {
  farmId: string
  key: string
  value: unknown
  sourceKey: string
  sourceSha256: string
  updatedAt: number
}

/** Row in `farm.spool_library_fields`. */
export interface SpoolFieldDefinitionRow {
  farmId: string
  entityType: SpoolEntityType
  key: string
  name: string
  fieldType: SpoolExtraFieldType
  sortOrder: number
  unit: string | null
  defaultValue: string | null
  choices: string[] | null
  multiChoice: boolean
  sourceKey: string
  sourceSha256: string
  updatedAt: number
}

/** Row in `farm.spool_locations`. */
export interface SpoolLocationRow {
  farmId: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** Row in `farm.spool_farm_settings` (farm default threshold and ISO-4217 currency). */
export interface SpoolFarmSettingsRow {
  farmId: string
  defaultLowStockThresholdGrams: number | null
  currency: string
  updatedAt: number
}

/** Per-filament threshold projection on `farm.spool_filaments`. */
export interface SpoolFilamentLowStockRow {
  farmId: string
  filamentId: SpoolRecordId
  lowStockThresholdGrams: number | null
}

/** Row in `farm.spool_slot_assignments`. */
export interface SpoolSlotAssignmentRow {
  farmId: string
  id: string
  spoolId: SpoolRecordId
  printerId: string
  slotKind: SpoolSlotKind
  slotIndex: number
  assignedAt: number
  unassignedAt: number | null
}

/**
 * Row in `farm.spool_usage_records`.
 * Cost per print = (spool.price ?? filament.price) / spool.initialWeight * grams.
 */
export interface SpoolUsageRecordRow {
  farmId: string
  id: string
  spoolId: SpoolRecordId
  jobId: number | null
  printerId: string | null
  grams: number
  source: SpoolUsageSource
  correctedBy: string | null
  createdAt: number
}

/** Row in `farm.spool_drying_logs`. */
export interface SpoolDryingLogRow {
  farmId: string
  id: string
  spoolId: SpoolRecordId
  startedAt: number
  endedAt: number | null
  temperatureCelsius: number
  notes: string | null
}

/** Row in `farm.spool_humidity_readings` (targets a spool, a slot, or both). */
export interface SpoolHumidityReadingRow {
  farmId: string
  id: string
  spoolId: SpoolRecordId | null
  printerId: string | null
  slotKind: SpoolSlotKind | null
  slotIndex: number | null
  humidityPercent: number
  source: SpoolHumiditySource
  recordedAt: number
}
