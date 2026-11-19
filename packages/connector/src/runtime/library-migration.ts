import {
  migrationDestination,
  planMigration,
  type LibraryMigrationDirectionValue,
  type LibraryMigrationOutcomeValue,
  type LibraryMigrationVersionValue,
  type MigrationStayReason,
} from '../../../farm-protocol/src/library-storage.ts'
import {
  LibraryStoreError,
  type LibraryStore,
  type VersionMeta,
} from './library-store.ts'

/**
 * Library mode switch (#446), run on the Connector over the existing session.
 * The result lists every version with where its file really is afterwards: a
 * version that could not move stays put and says why. Nothing is retried
 * automatically; a transfer that ends without confirmation leaves the source
 * copy in place.
 */
export interface LibraryTransferPort {
  /** Server to Connector: the file's bytes, fetched over the session. */
  pull(sha256: string, sizeBytes: number): Promise<AsyncIterable<Uint8Array>>
  /** Connector to server: resolves only once the server stored the bytes and verified the hash. */
  push(
    sha256: string,
    sizeBytes: number,
    source: AsyncIterable<Uint8Array>,
  ): Promise<void>
}

function toMeta(v: LibraryMigrationVersionValue): VersionMeta {
  return {
    version_id: v.version_id,
    item_id: v.item_id,
    version_number: v.version_number,
    name: v.name,
    kind: v.kind,
    created_at: v.created_at,
    ...(v.thumbnail === undefined ? {} : { thumbnail: v.thumbnail }),
  }
}

const STORE_REASON: Partial<Record<string, MigrationStayReason>> = {
  'disk-full': 'disk-full',
  'quota-exceeded': 'quota-exceeded',
  'hash-mismatch': 'hash-mismatch',
  'not-found': 'not-found',
}

function reasonOf(error: unknown, fallback: MigrationStayReason) {
  return error instanceof LibraryStoreError
    ? (STORE_REASON[error.code] ?? fallback)
    : fallback
}

export async function migrateLibrary(input: {
  direction: LibraryMigrationDirectionValue
  versions: readonly LibraryMigrationVersionValue[]
  store: LibraryStore
  transfer: LibraryTransferPort
}): Promise<LibraryMigrationOutcomeValue[]> {
  const { direction, store, transfer } = input
  const destination = migrationDestination(direction)
  const source = destination === 'connector' ? 'server' : 'connector'
  const plan = planMigration(direction, input.versions)
  const outcomes: LibraryMigrationOutcomeValue[] = [...plan.settled]
  const settle = (
    versions: readonly LibraryMigrationVersionValue[],
    result: { moved: true } | { moved: false; reason: MigrationStayReason },
  ) => {
    for (const v of versions)
      outcomes.push(
        result.moved
          ? {
              version_id: v.version_id,
              sha256: v.sha256,
              location: destination,
              outcome: 'moved',
            }
          : {
              version_id: v.version_id,
              sha256: v.sha256,
              location: source,
              outcome: 'stays',
              reason: result.reason,
            },
      )
  }

  // Deduplicated by hash: one transfer however many versions share the bytes.
  for (const move of plan.moves) {
    try {
      if (destination === 'connector') {
        const bytes = await transfer.pull(move.sha256, move.sizeBytes)
        // Hash and size are verified on write; a mismatch leaves nothing behind.
        await store.put(bytes, {
          expectedSha256: move.sha256,
          expectedSize: move.sizeBytes,
        })
        // One file, one row per version that uses it.
        for (const v of move.versions)
          await store.link(v.sha256, toMeta(v), v.pinned)
        settle(move.versions, { moved: true })
      } else {
        const file = await store.readVerified(move.sha256)
        try {
          await transfer.push(move.sha256, file.size, file.stream)
        } catch {
          // No confirmation: the file may or may not be on the server. Keep ours, never resend on its own.
          settle(move.versions, { moved: false, reason: 'transfer-uncertain' })
          continue
        }
        // The server confirmed the copy. A failed local cleanup only leaves an orphan the sweep removes.
        await store.release([move.sha256]).catch(() => undefined)
        settle(move.versions, { moved: true })
      }
    } catch (error) {
      settle(move.versions, {
        moved: false,
        reason: reasonOf(error, 'refused'),
      })
    }
  }
  return outcomes
}
