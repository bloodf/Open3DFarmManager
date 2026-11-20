import { describe, expect, it } from 'vitest'
import {
  fetchBambuCloudHistory,
  normalizeBambuCloudHistoryTasks,
} from '../../apps/farm/server/utils/bambu-cloud/import-history.ts'
import {
  importBambuCloudHistory,
  type BambuCloudHistoryPersistence,
} from '../../apps/farm/server/utils/bambu-cloud/import-history-http.ts'

const serial = '01P00A000000001'

describe('Bambu cloud history import', () => {
  it('normalizes completed task title, times and total plus per-slot grams', () => {
    const result = normalizeBambuCloudHistoryTasks({
      hits: [
        {
          id: 'task-1',
          dev_id: serial,
          title: ' Benchy ',
          status: 'success',
          start: 1_700_000_000,
          end: 1_700_003_600,
          weight: 12,
          filaments: [
            { slot: 0, grams: 10 },
            { slot: 1, grams: 2 },
          ],
        },
      ],
    })
    expect(result).toEqual({
      tasks: [
        {
          id: 'task-1',
          serial,
          title: 'Benchy',
          outcome: 'completed',
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_003_600_000,
          totalGrams: 12,
          filamentUsage: [
            { tool: 'slot-0', grams: 10 },
            { tool: 'slot-1', grams: 2 },
          ],
        },
      ],
      skipped: 0,
    })
  })

  it('omits tasks still printing or paused and skips malformed finished tasks', () => {
    const result = normalizeBambuCloudHistoryTasks({
      hits: [
        {
          id: 'live',
          dev_id: serial,
          title: 'Current',
          status: 'printing',
          start: 1,
          end: null,
        },
        {
          id: 'paused',
          dev_id: serial,
          title: 'Current',
          status: 'paused',
          start: 1,
          end: null,
        },
        { id: 'broken', title: 'No printer', status: 'success', end: 10 },
      ],
    })
    expect(result.tasks).toEqual([])
    expect(result.skipped).toBe(1)
  })

  it('deduplicates the cloud task feed by task ID', () => {
    const task = {
      id: 'same',
      dev_id: serial,
      title: 'Print',
      status: 'success',
      start: 1,
      end: 2,
      weight: 2,
      filaments: [],
    }
    const result = normalizeBambuCloudHistoryTasks({ hits: [task, task] })
    expect(result.tasks).toHaveLength(1)
    expect(result.skipped).toBe(1)
  })

  it('re-imports the same cloud task by updating its stored row', async () => {
    const farmId = '11111111-1111-4111-8111-111111111111'
    const rows = new Map<string, { title: string; grams: number | null }>()
    let title = 'First title'
    const persistence: BambuCloudHistoryPersistence = {
      assignment: async () => ({
        agentId: '22222222-2222-4222-8222-222222222222',
        printerKey: serial,
      }),
      upsert: async (_farm, assignment, task) => {
        const key = `${assignment.printerKey}:${task.id}`
        const existed = rows.has(key)
        rows.set(key, { title: task.title, grams: task.totalGrams })
        return existed ? 'updated' : 'inserted'
      },
    }
    const credentials = {
      load: async () => ({
        ok: true as const,
        credentials: {
          endpoint: 'https://127.0.0.1:1234',
          accessToken: '0123456789abcdef',
        },
      }),
    } as Parameters<typeof importBambuCloudHistory>[0]['credentials']
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        hits: [
          {
            id: 'same-task',
            dev_id: serial,
            title,
            status: 'success',
            start: 1,
            end: 2,
            weight: 12,
            filaments: [{ slot: 0, grams: 12 }],
          },
        ],
      })
    const run = () =>
      importBambuCloudHistory({
        farmId,
        credentials,
        policy: { bambuCloud: true },
        persistence,
        fetchImpl,
      })

    expect(await run()).toMatchObject({ imported: 1, updated: 0 })
    title = 'Corrected title'
    expect(await run()).toMatchObject({ imported: 0, updated: 1 })
    expect(rows.size).toBe(1)
    expect(rows.get(`${serial}:same-task`)).toEqual({
      title: 'Corrected title',
      grams: 12,
    })
  })

  it('fetches only the configured cloud endpoint and rejects auth errors', async () => {
    let requested = ''
    const response = await fetchBambuCloudHistory({
      endpoint: 'https://127.0.0.1:1234',
      accessToken: '0123456789abcdef',
      policy: { bambuCloud: true },
      fetchImpl: async (input) => {
        requested = String(input)
        return Response.json({ hits: [] })
      },
    })
    expect(requested).toBe('https://127.0.0.1:1234/v1/user-service/my/tasks')
    expect(response).toEqual({ ok: true, tasks: [], skipped: 0 })
    const unauthorized = await fetchBambuCloudHistory({
      endpoint: 'https://127.0.0.1:1234',
      accessToken: '0123456789abcdef',
      policy: { bambuCloud: true },
      fetchImpl: async () => new Response('{}', { status: 401 }),
    })
    expect(unauthorized).toEqual({ ok: false, reason: 'cloud-unauthorized' })
  })
})
