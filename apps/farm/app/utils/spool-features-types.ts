export type SlotKind = 'printer' | 'ams' | 'toolhead'

export interface PrinterRef {
  assignmentId: string
  printerKey: string
  status?: string
}

export interface SlotAssignment {
  farmId?: string
  id: string
  spoolId: number
  printerId: string
  slotKind: SlotKind
  slotIndex: number
  assignedAt: number
  unassignedAt: number | null
}

export interface UsageRecord {
  id: string
  spoolId: number
  jobId: number | null
  printerId: string | null
  grams: number
  source: string
  correctedBy: string | null
  createdAt: number
  cost: number | null
}

export interface UsageListResponse {
  currency: string
  records: UsageRecord[]
}

export type UsageGroupBy = 'job' | 'printer' | 'filament' | 'period'

export interface UsageReportRow {
  jobId?: number | null
  printerId?: string | null
  printerKey?: string | null
  filamentId?: number
  filamentName?: string | null
  material?: string | null
  period?: string
  records: number
  grams: number
  cost: number | null
  unpricedRecords: number
}

export interface UsageReport {
  currency: string
  groupBy: UsageGroupBy
  rows: UsageReportRow[]
}

export interface LowStockItem {
  filamentId: number
  name: string | null
  material: string | null
  remainingGrams: number | null
  thresholdGrams: number | null
  effectiveThresholdGrams: number | null
  low: boolean
}

export interface LowStockResponse {
  defaultLowStockThresholdGrams: number | null
  currency: string
  filaments: LowStockItem[]
}

export interface DryingLog {
  id: string
  spoolId: number
  startedAt: number
  endedAt: number | null
  temperatureCelsius: number
  notes: string | null
}

export interface HumidityReading {
  id: string
  spoolId: number | null
  printerId: string | null
  slotKind: SlotKind | null
  slotIndex: number | null
  humidityPercent: number
  source: 'manual' | 'ams'
  recordedAt: number
}
