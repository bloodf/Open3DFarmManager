import { createHash } from 'node:crypto'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Sql } from 'postgres'
import { createBlobStore } from '../../apps/farm/server/utils/library/blob-store.ts'
import { runLibraryRetention } from '../../apps/farm/server/utils/library/retention.ts'

const now = 1_800_000_000_000
const farmId = '11111111-1111-4111-8111-111111111111'
const agents = [
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]
const bytes = Buffer.from('same bytes')
const sha256 = createHash('sha256').update(bytes).digest('hex')

describe('retention by location', () => {
  test('purges each copy once and permits a fresh upload', async () => {
    const rows = [null, ...agents].map((agentId) => ({
      farmId,
      sha256,
      sizeBytes: bytes.length,
      location: agentId === null ? ('server' as const) : ('connector' as const),
      agentId,
      createdAt: 0,
      retentionDays: 30,
      refs: 1,
      live: false,
      newestDeletedAt: 0,
      purgedAt: null as number | null,
    }))
    const dir = await mkdtemp(join(tmpdir(), 'retention-378-'))
    const disk = await createBlobStore(dir)
    const upload = () =>
      disk.put(
        (async function* () {
          yield bytes
        })(),
      )
    expect((await upload()).created).toBe(true)
    const files = new Map<string, Buffer>(
      agents.map((id): [string, Buffer] => [id, bytes]),
    )
    const removals: string[] = []
    const fragment = { fragment: true }
    const query = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<unknown> => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim()
      if (text.startsWith('SELECT b.farm_id')) {
        expect(text).toContain('v.storage_location = b.storage_location')
        expect(text).toContain('v.location_agent_id = b.location_agent_id')
        return fragment
      }
      if (text.startsWith('GROUP BY')) return fragment
      if (
        text.startsWith('SET LOCAL') ||
        text.includes('pg_advisory_xact_lock') ||
        text.startsWith('UPDATE farm.library_versions')
      )
        return []
      if (text.includes('HAVING'))
        return rows.filter((row) => row.purgedAt === null)
      if (text.includes('b.sha256=')) {
        expect(text).toContain('b.storage_location=')
        expect(text).toContain('b.agent_id IS NOT DISTINCT FROM')
        const [, farm, hash, location, agent] = values
        return rows.filter(
          (r) =>
            r.farmId === farm &&
            r.sha256 === hash &&
            r.location === location &&
            r.agentId === agent &&
            r.purgedAt === null,
        )
      }
      if (text.startsWith('UPDATE farm.library_blobs SET purged_at')) {
        expect(text).toContain('storage_location=')
        expect(text).toContain('agent_id IS NOT DISTINCT FROM')
        const [at, farm, hash, location, agent] = values
        const row = rows.find(
          (r) =>
            r.farmId === farm &&
            r.sha256 === hash &&
            r.location === location &&
            r.agentId === agent &&
            r.purgedAt === null,
        )
        if (!row) return []
        row.purgedAt = at as number
        return [{}]
      }
      if (text.startsWith('SELECT 1 FROM farm.library_blobs'))
        return rows.some((r) => r.location === 'server' && r.purgedAt === null)
          ? [{}]
          : []
      if (text.startsWith('SELECT DISTINCT sha256')) return []
      if (text.startsWith('SELECT DISTINCT agent_id'))
        return agents.map((agentId) => ({ agentId }))
      if (text.startsWith('SELECT sha256 FROM farm.library_blobs'))
        return rows
          .filter((r) => r.agentId === values[0] && r.purgedAt === null)
          .map((r) => ({ sha256: r.sha256 }))
      throw new Error(`unexpected SQL: ${text}`)
    }
    const sql = Object.assign(query, {
      begin: async (fn: (tx: typeof query) => Promise<unknown>) => fn(query),
    }) as unknown as Sql
    const blobs = {
      ...disk,
      remove: async (hash: string) => {
        removals.push('server')
        return disk.remove(hash)
      },
    }
    const connectors = {
      purge: async (agent: string, hashes: readonly string[]) => {
        removals.push(agent)
        files.delete(agent)
        return [...hashes]
      },
      sweep: async () => [],
    }
    const deps = { sql, blobs, connectors, clock: () => now }
    expect(await runLibraryRetention(deps, { batchSize: 10 })).toMatchObject({
      blobsPurged: 3,
      failed: 0,
    })
    expect(rows.map((row) => row.purgedAt)).toEqual([now, now, now])
    expect(removals).toEqual(['server', ...agents])
    expect(files.size).toBe(0)
    expect(await runLibraryRetention(deps, { batchSize: 10 })).toMatchObject({
      blobsPurged: 0,
      failed: 0,
    })
    expect(removals).toHaveLength(3)
    expect(await disk.has(sha256)).toBe(false)
    expect((await upload()).created).toBe(true)
    const read = await disk.read(sha256)
    const chunks: Buffer[] = []
    for await (const chunk of read.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(bytes)
    await disk.remove(sha256)
    await rmdir(join(dir, '.tmp'))
    await rmdir(dir)
  })
})
