export type SpoolLibraryAccess = 'read' | 'write' | 'manage'

export interface VendorItem {
  id: number
  registered: string
  name: string
  comment?: string
  empty_spool_weight?: number
  external_id?: string
  extra: Record<string, string>
}

export interface FilamentItem {
  id: number
  registered: string
  name?: string
  vendor?: VendorItem
  material?: string
  price?: number
  density: number
  diameter: number
  weight?: number
  spool_weight?: number
  article_number?: string
  comment?: string
  settings_extruder_temp?: number
  settings_bed_temp?: number
  color_hex?: string
  multi_color_hexes?: string
  multi_color_direction?: 'coaxial' | 'longitudinal'
  external_id?: string
  extra: Record<string, string>
}

export interface SpoolItem {
  id: number
  registered: string
  first_used?: string
  last_used?: string
  filament: FilamentItem
  price?: number
  remaining_weight?: number
  initial_weight?: number
  spool_weight?: number
  used_weight: number
  remaining_length?: number
  used_length: number
  location?: string
  lot_nr?: string
  comment?: string
  archived: boolean
  extra: Record<string, string>
}

export interface SpoolLibraryListResponse<T> {
  items: T[]
  total: number
  access: SpoolLibraryAccess
  canWrite: boolean
  canImport: boolean
}

export interface SpoolLibraryItemResponse<T> {
  item: T
  access?: SpoolLibraryAccess
  canWrite?: boolean
  canImport?: boolean
}

export interface ImportCounts {
  created: number
  updated: number
  unchanged: number
  adopted: number
  conflicts: number
}

export interface ImportConflict {
  kind: 'vendor' | 'filament' | 'spool' | 'field' | 'setting'
  id: string
}

export interface ImportReport {
  runId: string
  dryRun: boolean
  sourceKey: string
  vendors: ImportCounts
  filaments: ImportCounts
  spools: ImportCounts
  fields: ImportCounts
  settings: ImportCounts
  truncated: number
  skippedSettings: string[]
  conflicts: ImportConflict[]
}

export interface BundleProblem {
  path: string
  problem: string
}

export interface SpoolFilters {
  q: string
  material: string
  vendorId: string
  location: string
  allowArchived: boolean
  sort: string
}

export interface FilamentFilters {
  q: string
  material: string
  vendorId: string
  sort: string
}

export interface VendorFilters {
  q: string
  sort: string
}

export type ImportFormat = 'spoolman-api' | 'json' | 'csv'
export type ImportCsvEntity = 'vendors' | 'filaments' | 'spools'
export type ImportCollisionPolicy = 'adopt' | 'create'
export type ImportConflictPolicy = 'keep-local' | 'overwrite'
