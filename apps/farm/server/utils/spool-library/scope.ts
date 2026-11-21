/**
 * Reusable farm-scoped spool storage contract for the API units that follow.
 *
 * A caller never names a farm when it reads or writes spool data. It obtains a
 * `SpoolLibraryRepository` from `SpoolLibraryStorage.withScope`, which fixes
 * the farm from an authority (a signed-in member session or a legacy
 * credential) inside one transaction. Every repository method is bound to that
 * farm; there is no farm argument to get wrong.
 */
import type { SessionPolicy } from '../auth/session-contract.ts'

/** Spoolman-style integer record id, allocated per farm. */
export type SpoolRecordId = number

export type SpoolLibraryAccess = 'read' | 'write' | 'manage'

export type SpoolLibraryAuthority =
  | {
      kind: 'session'
      sessionRecordId: string
      policy: SessionPolicy
      farmId: string
    }
  | { kind: 'legacy-credential'; token: string }

export type SpoolLibraryFailureReason =
  | 'invalid-input'
  | 'unauthorized'
  | 'forbidden'
  | 'denied'
  | 'not-found'
  | 'conflict'
  | 'limit'
  | 'storage-unavailable'

export interface SpoolLibraryFailure {
  ok: false
  reason: SpoolLibraryFailureReason
}

export interface SpoolVendor {
  id: SpoolRecordId
  name: string
  comment: string | null
  emptySpoolWeight: number | null
  externalId: string | null
  extra: Record<string, unknown>
  registeredAt: number
}
export interface SpoolVendorInput {
  name: string
  comment?: string | null
  emptySpoolWeight?: number | null
  externalId?: string | null
  extra?: Record<string, unknown>
}

export interface SpoolFilament {
  id: SpoolRecordId
  vendorId: SpoolRecordId | null
  name: string | null
  material: string | null
  colorHex: string | null
  multiColorHexes: string | null
  multiColorDirection: 'coaxial' | 'longitudinal' | null
  articleNumber: string | null
  settingsExtruderTemp: number | null
  settingsBedTemp: number | null
  density: number
  diameter: number
  weight: number | null
  spoolWeight: number | null
  price: number | null
  comment: string | null
  externalId: string | null
  extra: Record<string, unknown>
  registeredAt: number
}
export interface SpoolFilamentInput {
  vendorId?: SpoolRecordId | null
  name?: string | null
  material?: string | null
  colorHex?: string | null
  multiColorHexes?: string | null
  multiColorDirection?: 'coaxial' | 'longitudinal' | null
  articleNumber?: string | null
  settingsExtruderTemp?: number | null
  settingsBedTemp?: number | null
  density: number
  diameter: number
  weight?: number | null
  spoolWeight?: number | null
  price?: number | null
  comment?: string | null
  externalId?: string | null
  extra?: Record<string, unknown>
}

export interface Spool {
  id: SpoolRecordId
  filamentId: SpoolRecordId
  initialWeight: number | null
  spoolWeight: number | null
  usedWeight: number
  price: number | null
  location: string | null
  lotNr: string | null
  comment: string | null
  archived: boolean
  extra: Record<string, unknown>
  registeredAt: number
  firstUsedAt: number | null
  lastUsedAt: number | null
}
export interface SpoolInput {
  filamentId: SpoolRecordId
  initialWeight?: number | null
  spoolWeight?: number | null
  usedWeight?: number
  price?: number | null
  location?: string | null
  lotNr?: string | null
  comment?: string | null
  archived?: boolean
  extra?: Record<string, unknown>
  firstUsedAt?: number | null
  lastUsedAt?: number | null
}

export interface PageInput {
  limit: number
  /** Return records with an id greater than this one. */
  afterId?: SpoolRecordId
}

export type Result<T> = { ok: true; value: T } | SpoolLibraryFailure

interface Crud<T, Input, Patch> {
  list(page: PageInput): Promise<Result<T[]>>
  get(id: SpoolRecordId): Promise<Result<T>>
  create(input: Input): Promise<Result<T>>
  update(id: SpoolRecordId, patch: Patch): Promise<Result<T>>
  delete(id: SpoolRecordId): Promise<Result<true>>
}

export type SpoolEntityType = 'vendor' | 'filament' | 'spool'
export type SpoolExtraFieldType =
  | 'text'
  | 'integer'
  | 'integer_range'
  | 'float'
  | 'float_range'
  | 'datetime'
  | 'boolean'
  | 'choice'

/** One per-farm extra-field definition (Spoolman `ExtraField`). */
export interface SpoolExtraFieldDefinition {
  entityType: SpoolEntityType
  key: string
  name: string
  fieldType: SpoolExtraFieldType
  order: number
  unit: string | null
  defaultValue: string | null
  choices: string[] | null
  multiChoice: boolean
}

/** One stored farm setting; `value` is the parsed JSON value. */
export interface SpoolSetting {
  key: string
  value: unknown
}

/** Farm-bound repository. Mutations on a `read` scope resolve to `denied`. */
export interface SpoolLibraryRepository {
  readonly farmId: string
  readonly access: SpoolLibraryAccess
  /** This farm's extra-field registry (Spoolman `/field`). */
  readonly extraFields: {
    list(entity: SpoolEntityType): Promise<Result<SpoolExtraFieldDefinition[]>>
    /** Insert or replace one definition (key and entity identify it). */
    upsert(definition: SpoolExtraFieldDefinition): Promise<Result<true>>
    /** Remove a definition and its value from every record of that entity. */
    delete(entity: SpoolEntityType, key: string): Promise<Result<true>>
  }
  /** Settings the farm has set; unset keys are absent (Spoolman `/setting`). */
  readonly settings: {
    list(): Promise<Result<SpoolSetting[]>>
    set(key: string, value: unknown): Promise<Result<true>>
    /** Back to the default: drops the stored value. */
    reset(key: string): Promise<Result<true>>
  }
  /** Spool locations (Spoolman `/location`, `PATCH /spool/field/location`). */
  readonly locations: {
    /** Distinct locations held by this farm's spools, ascending. */
    list(): Promise<Result<string[]>>
  }
  /**
   * Rename one value of one spool field wherever it occurs (archived spools
   * included); returns how many spools changed. `field` is `location` or
   * `extra.<key>`. Renaming onto a value in use merges the two.
   */
  renameSpoolFieldValue(
    field: string,
    from: string,
    to: string,
  ): Promise<Result<number>>
  readonly vendors: Crud<
    SpoolVendor,
    SpoolVendorInput,
    Partial<SpoolVendorInput>
  >
  readonly filaments: Crud<
    SpoolFilament,
    SpoolFilamentInput,
    Partial<SpoolFilamentInput>
  >
  readonly spools: Crud<Spool, SpoolInput, Partial<SpoolInput>> & {
    /** Add consumed grams; stamps first/last use. Spoolman `PUT /spool/{id}/use`. */
    use(id: SpoolRecordId, grams: number): Promise<Result<Spool>>
  }
}

export interface LegacyCredentialSummary {
  id: string
  label: string
  access: 'read' | 'write'
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export interface SpoolLibraryStorage {
  /**
   * Resolve the authority to exactly one farm and run `work` inside a single
   * transaction. A rejected or failing scope never exposes another farm.
   */
  withScope<T>(
    authority: SpoolLibraryAuthority,
    work: (repository: SpoolLibraryRepository) => Promise<Result<T>>,
  ): Promise<Result<T>>

  /** Owner/admin session only. The returned token is shown once and never stored. */
  issueLegacyCredential(input: {
    sessionRecordId: string
    policy: SessionPolicy
    farmId: string
    label: string
    access: 'read' | 'write'
  }): Promise<Result<{ credential: LegacyCredentialSummary; token: string }>>
  listLegacyCredentials(input: {
    sessionRecordId: string
    policy: SessionPolicy
    farmId: string
  }): Promise<Result<LegacyCredentialSummary[]>>
  revokeLegacyCredential(input: {
    sessionRecordId: string
    policy: SessionPolicy
    farmId: string
    credentialId: string
  }): Promise<Result<true>>
}
