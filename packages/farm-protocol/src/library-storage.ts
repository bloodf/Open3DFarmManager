import { z } from 'zod'

/**
 * Connector-mode print library frames (#446). They carry metadata, thumbnail
 * and hash only: strict schemas have no field a file's bytes could ride in.
 * Retention constants match the server job (#378).
 */
export const LIBRARY_DEFAULT_RETENTION_DAYS = 30
/** Files younger than this may belong to an upload still in flight. */
export const LIBRARY_ORPHAN_GRACE_MS = 3_600_000
export const MAX_LIBRARY_LIST_ENTRIES = 200
export const MAX_LIBRARY_MIGRATION_VERSIONS = 500

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const location = z.enum(['server', 'connector'])
const PNG_MAGIC = '\x89PNG\r\n\x1a\n'
const thumbnail = z
  .string()
  .max(87384)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => {
    try {
      const bytes = atob(value)
      return bytes.length <= 65536 && bytes.startsWith(PNG_MAGIC)
    } catch {
      return false
    }
  })

/** What the server needs to list one version; never the file. */
export const LibraryVersionMeta = z.strictObject({
  version_id: id,
  item_id: id,
  version_number: z.number().int().positive(),
  sha256,
  size_bytes: count,
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !/[\\/\u0000-\u001f\u007f-\u009f]/.test(name)),
  kind: z.enum(['gcode', '3mf']),
  created_at: count,
  thumbnail: thumbnail.optional(),
})
export type LibraryVersionMetaValue = z.infer<typeof LibraryVersionMeta>

export const LibraryFileState = z.enum(['stored', 'missing', 'removed'])
export const LibraryFileEntry = LibraryVersionMeta.extend({
  pinned: z.boolean(),
  /** `missing`: indexed but the file is gone from disk. `removed`: retention or quota removed it. */
  state: LibraryFileState,
})
export type LibraryFileEntryValue = z.infer<typeof LibraryFileEntry>

export const LibraryListRequest = z.strictObject({
  type: z.literal('library.files.list'),
  request_id: id,
})
export const LibraryListResponse = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('library.files.list.result'),
    request_id: id,
    ok: z.literal(true),
    files: z
      .array(LibraryFileEntry)
      .max(MAX_LIBRARY_LIST_ENTRIES)
      .refine(
        (files) =>
          files.filter((file) => file.thumbnail !== undefined).length <= 50,
      ),
  }),
  z.strictObject({
    type: z.literal('library.files.list.result'),
    request_id: id,
    ok: z.literal(false),
    reason: z.enum(['unauthorized', 'unavailable']),
  }),
])

/** The host's own quota and usage, reported to the farm (`library_connector_storage`). */
export const LibraryStorageReport = z.strictObject({
  type: z.literal('library.storage.report'),
  quota_bytes: count,
  used_bytes: count,
  retention_days: z.number().int().min(1).max(3650),
  keep_versions: z.number().int().min(1).max(1000).nullable(),
  reported_at: count,
})
export type LibraryStorageReportValue = z.infer<typeof LibraryStorageReport>

export const LibraryRemovalReason = z.enum([
  'quota',
  'retention',
  'requested',
  'orphan',
])
export const LibraryRemoval = z.strictObject({
  sha256,
  size_bytes: count,
  version_ids: z.array(id).max(1000),
  reason: LibraryRemovalReason,
})
export type LibraryRemovalValue = z.infer<typeof LibraryRemoval>
/** What the Connector actually removed, so the server can mark those versions "arquivo removido". */
export const LibraryRemovalReport = z.strictObject({
  type: z.literal('library.removed'),
  removed: z.array(LibraryRemoval).max(MAX_LIBRARY_LIST_ENTRIES),
})

export const LibraryMigrationDirection = z.enum([
  'server-to-connector',
  'connector-to-server',
])
export type LibraryMigrationDirectionValue = z.infer<
  typeof LibraryMigrationDirection
>
export const LibraryMigrationVersion = LibraryVersionMeta.extend({
  /** Where the version's file is now, as the server recorded it. */
  location,
  /** Retention already removed the file: nothing to move. */
  purged: z.boolean(),
  pinned: z.boolean().default(false),
})
export type LibraryMigrationVersionValue = z.infer<
  typeof LibraryMigrationVersion
>
export const LibraryMigrationRequest = z.strictObject({
  type: z.literal('library.migrate'),
  request_id: id,
  direction: LibraryMigrationDirection,
  versions: z
    .array(LibraryMigrationVersion)
    .max(MAX_LIBRARY_MIGRATION_VERSIONS),
})

export const MIGRATION_STAY_REASONS = [
  'purged',
  'disk-full',
  'quota-exceeded',
  'hash-mismatch',
  'not-found',
  'transfer-uncertain',
  'refused',
] as const
export type MigrationStayReason = (typeof MIGRATION_STAY_REASONS)[number]

/** One line per version: where it is after the switch, and why when it did not move. */
export const LibraryMigrationOutcome = z.strictObject({
  version_id: id,
  sha256,
  /** The real location after the run (never rewritten for a version that stayed). */
  location,
  outcome: z.enum(['moved', 'already-there', 'stays']),
  reason: z.enum(MIGRATION_STAY_REASONS).optional(),
})
export type LibraryMigrationOutcomeValue = z.infer<
  typeof LibraryMigrationOutcome
>
export const LibraryMigrationResult = z.strictObject({
  type: z.literal('library.migrate.result'),
  request_id: id,
  direction: LibraryMigrationDirection,
  outcomes: z
    .array(LibraryMigrationOutcome)
    .max(MAX_LIBRARY_MIGRATION_VERSIONS),
})

export const MIGRATION_REASON_TEXT: Record<MigrationStayReason, string> = {
  purged: 'o arquivo já foi removido pela retenção',
  'disk-full': 'não há espaço livre em disco no destino',
  'quota-exceeded': 'a cota da biblioteca no destino foi excedida',
  'hash-mismatch': 'o arquivo não confere com o SHA-256 e foi recusado',
  'not-found': 'o arquivo não foi encontrado na origem',
  'transfer-uncertain':
    'a transferência terminou sem confirmação; nada foi repetido automaticamente',
  refused: 'o destino recusou o arquivo',
}

export interface MigrationPlan {
  /** One entry per distinct hash that has to travel, with every version using it. */
  moves: {
    sha256: string
    sizeBytes: number
    versions: LibraryMigrationVersionValue[]
  }[]
  /** Versions that need no transfer. */
  settled: LibraryMigrationOutcomeValue[]
}

/** Which side holds the file before a switch in this direction. */
const SOURCE = {
  'server-to-connector': 'server',
  'connector-to-server': 'connector',
} as const
const DESTINATION = {
  'server-to-connector': 'connector',
  'connector-to-server': 'server',
} as const

export function migrationDestination(
  direction: LibraryMigrationDirectionValue,
) {
  return DESTINATION[direction]
}

/**
 * Splits the farm's versions into files to move (deduplicated by hash: one
 * transfer even when several versions share the bytes) and versions that are
 * already settled: at the destination, held on the other side, or purged.
 */
export function planMigration(
  direction: LibraryMigrationDirectionValue,
  versions: readonly LibraryMigrationVersionValue[],
): MigrationPlan {
  const byHash = new Map<string, MigrationPlan['moves'][number]>()
  const settled: LibraryMigrationOutcomeValue[] = []
  for (const version of versions) {
    const base = { version_id: version.version_id, sha256: version.sha256 }
    if (version.location === DESTINATION[direction])
      settled.push({
        ...base,
        location: version.location,
        outcome: 'already-there',
      })
    else if (version.purged)
      settled.push({
        ...base,
        location: version.location,
        outcome: 'stays',
        reason: 'purged',
      })
    else if (version.location !== SOURCE[direction])
      settled.push({
        ...base,
        location: version.location,
        outcome: 'stays',
        reason: 'refused',
      })
    else {
      const move = byHash.get(version.sha256)
      if (move) move.versions.push(version)
      else
        byHash.set(version.sha256, {
          sha256: version.sha256,
          sizeBytes: version.size_bytes,
          versions: [version],
        })
    }
  }
  return { moves: [...byHash.values()], settled }
}

export interface MigrationSummary {
  moved: number
  alreadyThere: number
  stays: number
  /** Accessible pt-BR line per version that stays, with where it remains. */
  messages: string[]
}

const PLACE = {
  server: 'no servidor',
  connector: 'no computador do Conector',
} as const

export function summarizeMigration(
  outcomes: readonly LibraryMigrationOutcomeValue[],
): MigrationSummary {
  const summary: MigrationSummary = {
    moved: 0,
    alreadyThere: 0,
    stays: 0,
    messages: [],
  }
  for (const outcome of outcomes) {
    if (outcome.outcome === 'moved') summary.moved++
    else if (outcome.outcome === 'already-there') summary.alreadyThere++
    else {
      summary.stays++
      const why = MIGRATION_REASON_TEXT[outcome.reason ?? 'refused']
      summary.messages.push(
        `Versão ${outcome.version_id} permanece ${PLACE[outcome.location]}: ${why}.`,
      )
    }
  }
  return summary
}
