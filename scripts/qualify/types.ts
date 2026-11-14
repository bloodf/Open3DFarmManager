// SPDX-License-Identifier: MIT

export type SupportedVendor =
  'moonraker' | 'klipper' | 'bambu' | 'creality' | 'anycubic' | 'kobralink'

export interface QualifyCliOptions {
  vendor: string
  host: string
  port?: number | undefined
  credentialFile?: string | undefined
  serial?: string | undefined
  timeoutMs?: number | undefined
  cameraPort?: number | undefined
  ftpsPort?: number | undefined
  caFile?: string | undefined
  pinSha256?: string | undefined
  webcamOrigin?: string | undefined
}

export interface ObservedIdentity {
  vendor?: string | null | undefined
  model?: string | null | undefined
  firmware?: string | null | undefined
  serial?: string | null | undefined
  hostname?: string | null | undefined
  raw?: Record<string, unknown> | undefined
}

export interface ObservedTelemetry {
  observed: boolean
  fields: string[]
  sample?: Record<string, unknown> | undefined
}

export interface ObservedCamera {
  reachable: boolean
  kind?: 'mjpeg' | 'jpeg' | 'rtsps' | 'webcam' | 'unknown' | null | undefined
  url?: string | null | undefined
  detail?: string | null | undefined
}

export interface ObservedFileEntry {
  name: string
  size?: number | undefined
  modified?: number | string | undefined
  estimatedTime?: number | undefined
}

export interface ObservedFiles {
  listable: boolean
  count: number
  files: ObservedFileEntry[]
  reason?: string | undefined
}

export interface CatalogPromotionInfo {
  matchedCatalogId: string | null
  matchedCatalogBrand: string | null
  matchedCatalogModel: string | null
  currentCapabilities: Record<string, string> | null
  provenCapabilities: {
    telemetry: boolean
    camera: boolean
    files: boolean
  }
  canPromoteToHardwareProven: boolean
  promotionNotes: string[]
}

export interface QualificationReport {
  vendor: string
  host: string
  port: number
  timestamp: string
  identity: ObservedIdentity
  telemetry: ObservedTelemetry
  camera: ObservedCamera
  files: ObservedFiles
  catalog: CatalogPromotionInfo
  qualification: {
    status: 'qualified' | 'partially_qualified' | 'unreachable'
    summary: string
  }
}
