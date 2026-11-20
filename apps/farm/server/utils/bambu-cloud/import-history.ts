import type { FilamentUsage } from '@open3dfarmmanager/farm-protocol'
import {
  isBambuCloudEnabled,
  resolveBambuCloudEndpoint,
} from '../../../../../packages/connector/src/bambu/cloud.ts'
import type { BambuCloudFailure } from './account.ts'

const TOKEN = /^[\x21-\x7E]{16,4096}$/
const MAX_BODY = 1_048_576
const MAX_TASKS = 1000

export interface BambuCloudHistoryTask {
  id: string
  serial: string
  title: string
  outcome: 'completed' | 'cancelled' | 'failed'
  startedAt: number | null
  endedAt: number
  totalGrams: number | null
  filamentUsage: FilamentUsage[]
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return null
  const millis = value < 100_000_000_000 ? value * 1000 : value
  return Number.isSafeInteger(Math.trunc(millis)) ? Math.trunc(millis) : null
}

export function normalizeBambuCloudHistoryTasks(value: unknown): {
  tasks: BambuCloudHistoryTask[]
  skipped: number
} {
  const root = record(value)
  const hits = root?.hits
  if (!Array.isArray(hits)) return { tasks: [], skipped: 0 }
  const tasks: BambuCloudHistoryTask[] = []
  let skipped = 0
  const seen = new Set<string>()
  for (const raw of hits.slice(0, MAX_TASKS)) {
    const task = record(raw)
    const id = task?.id
    const serial = task?.dev_id ?? task?.device_id ?? task?.printer_serial
    const status = task?.status
    // Ongoing cloud tasks never become job history rows.
    if (status === 'printing' || status === 'paused' || status === 'running')
      continue
    const startedAt = timestamp(task?.start)
    const endedAt = timestamp(task?.end)
    if (
      typeof id !== 'string' ||
      !/^[\w.-]{1,128}$/.test(id) ||
      typeof serial !== 'string' ||
      !/^[0-9A-Z]{10,20}$/.test(serial) ||
      typeof task?.title !== 'string' ||
      !task.title.trim() ||
      task.title.length > 255 ||
      endedAt === null ||
      (startedAt !== null && endedAt < startedAt) ||
      seen.has(id)
    ) {
      skipped += 1
      continue
    }
    const outcome =
      status === 'success'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : 'cancelled'
    const sourceFilaments = Array.isArray(task.filaments) ? task.filaments : []
    const filamentUsage: FilamentUsage[] = []
    for (const item of sourceFilaments) {
      const filament = record(item)
      if (
        !filament ||
        !Number.isInteger(filament.slot) ||
        (filament.slot as number) < 0 ||
        typeof filament.grams !== 'number' ||
        !Number.isFinite(filament.grams) ||
        filament.grams < 0 ||
        filament.grams > 100_000
      )
        continue
      filamentUsage.push({
        tool: `slot-${filament.slot}`,
        grams: filament.grams,
      })
    }
    const totalGrams =
      typeof task.weight === 'number' &&
      Number.isFinite(task.weight) &&
      task.weight >= 0 &&
      task.weight <= 100_000
        ? task.weight
        : filamentUsage.reduce((sum, item) => sum + (item.grams ?? 0), 0) ||
          null
    seen.add(id)
    tasks.push({
      id,
      serial,
      title: task.title.trim(),
      outcome,
      startedAt,
      endedAt,
      totalGrams,
      filamentUsage,
    })
  }
  return { tasks, skipped: skipped + Math.max(0, hits.length - MAX_TASKS) }
}

export async function fetchBambuCloudHistory(input: {
  endpoint: string
  accessToken: string
  policy: unknown
  fetchImpl?: typeof fetch
}): Promise<
  | { ok: true; tasks: BambuCloudHistoryTask[]; skipped: number }
  | { ok: false; reason: Extract<BambuCloudFailure, `cloud-${string}`> }
> {
  if (!isBambuCloudEnabled(input.policy))
    return { ok: false, reason: 'cloud-disabled' }
  if (!TOKEN.test(input.accessToken))
    return { ok: false, reason: 'cloud-rejected' }
  let base: URL
  try {
    base = resolveBambuCloudEndpoint(input.endpoint, input.policy)
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/'
    )
      return { ok: false, reason: 'cloud-rejected' }
  } catch {
    return { ok: false, reason: 'cloud-rejected' }
  }
  try {
    const response = await (input.fetchImpl ?? fetch)(
      new URL('/v1/user-service/my/tasks', base),
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.accessToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      },
    )
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BODY)
      return { ok: false, reason: 'cloud-rejected' }
    const body = await response.text()
    if (body.length > MAX_BODY) return { ok: false, reason: 'cloud-rejected' }
    if (response.status === 401 || response.status === 403)
      return { ok: false, reason: 'cloud-unauthorized' }
    if (response.status !== 200) return { ok: false, reason: 'cloud-rejected' }
    const normalized = normalizeBambuCloudHistoryTasks(
      JSON.parse(body) as unknown,
    )
    return { ok: true, ...normalized }
  } catch {
    return { ok: false, reason: 'cloud-rejected' }
  }
}
