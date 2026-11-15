// postgres integration not run: storage SQL is covered only by the logic below.
import { describe, expect, it } from 'vitest'
import type { TelemetryEvent } from '@open3dfarmmanager/farm-protocol'
import {
  JOB_HISTORY_READ_ROLES,
  canReadJobHistory,
  jobHistoryCursor,
  jobsFromEvents,
} from '../../apps/farm/server/services/job-history-core.ts'
import { parseJobHistoryQuery } from '../../apps/farm/server/services/job-history.ts'
import {
  jobHistoryRow,
  jobHistoryStatus,
} from '../../apps/farm/app/utils/job-history-view.ts'

const farmId = '3f0f8b7e-6a43-4f6e-9d3a-0b6a8f1f2c11'
let n = 0
const eventId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const snapshot = (
  printerKey: string,
  lastJob?: Record<string, unknown>,
): TelemetryEvent =>
  ({
    eventId: eventId(),
    queuedAt: 1,
    kind: 'printer-state',
    state: {
      printerKey,
      state: 'idle',
      observedAt: 5000,
      ...(lastJob ? { lastJob } : {}),
    },
  }) as TelemetryEvent
const job = { outcome: 'completed', filename: 'a.gcode', endedAt: 1000 }

describe('jobsFromEvents', () => {
  it('ignores snapshots without a finished job and non-snapshot events', () => {
    const transition = {
      eventId: eventId(),
      queuedAt: 1,
      kind: 'printer-transition',
      transition: {
        printerKey: 'p1',
        from: 'printing',
        to: 'idle',
        observedAt: 1,
      },
    } as TelemetryEvent
    expect(jobsFromEvents([snapshot('p1'), transition])).toEqual([])
  })
  it('maps fields and omits absent optionals', () => {
    expect(
      jobsFromEvents([
        snapshot('p1', { ...job, printDuration: 60, totalDuration: 90 }),
        snapshot('p2', { outcome: 'failed', endedAt: 2000 }),
      ]),
    ).toEqual([
      {
        printerKey: 'p1',
        outcome: 'completed',
        filename: 'a.gcode',
        printDurationSeconds: 60,
        totalDurationSeconds: 90,
        endedAt: 1000,
      },
      { printerKey: 'p2', outcome: 'failed', endedAt: 2000 },
    ])
  })
  it('dedupes repeated lastJob per printer and end time, first wins', () => {
    const jobs = jobsFromEvents([
      snapshot('p1', job),
      snapshot('p1', { ...job, outcome: 'failed' }),
      snapshot('p2', job),
      snapshot('p1', { ...job, endedAt: 3000 }),
    ])
    expect(jobs.map((j) => [j.printerKey, j.endedAt, j.outcome])).toEqual([
      ['p1', 1000, 'completed'],
      ['p2', 1000, 'completed'],
      ['p1', 3000, 'completed'],
    ])
  })
  it('does not conflate keys that merely concatenate alike', () => {
    expect(
      jobsFromEvents([
        snapshot('p1', { ...job, endedAt: 11 }),
        snapshot('p11', { ...job, endedAt: 1 }),
      ]),
    ).toHaveLength(2)
  })
})

describe('roles', () => {
  it('lets every farm role read and rejects anything else', () => {
    for (const role of JOB_HISTORY_READ_ROLES)
      expect(canReadJobHistory(role)).toBe(true)
    for (const role of ['', 'guest', 'OWNER', null, undefined, 1])
      expect(canReadJobHistory(role)).toBe(false)
  })
})

describe('query parsing', () => {
  const url = (q: string) => `http://localhost/api/job-history?${q}`
  it('accepts a bounded page request', () => {
    expect(
      parseJobHistoryQuery(
        url(`farmId=${farmId}&limit=50&before=123-45&printerKey=p1`),
      ),
    ).toEqual({ farmId, printerKey: 'p1', limit: 50, before: '123-45' })
    expect(parseJobHistoryQuery(url(`farmId=${farmId}`))).toEqual({
      farmId,
      printerKey: null,
      limit: 20,
      before: null,
    })
  })
  it('rejects bad farms, limits, cursors, duplicates and unknown keys', () => {
    for (const q of [
      '',
      'farmId=nope',
      `farmId=${farmId}&limit=0`,
      `farmId=${farmId}&limit=51`,
      `farmId=${farmId}&before=12`,
      `farmId=${farmId}&before=1-2;DROP`,
      `farmId=${farmId}&farmId=${farmId}`,
      `farmId=${farmId}&extra=1`,
      `farmId=${farmId}&printerKey=${'x'.repeat(129)}`,
    ])
      expect(() => parseJobHistoryQuery(url(q))).toThrow()
    expect(jobHistoryCursor.test('1-2')).toBe(true)
  })
})

describe('page view', () => {
  it('formats a row in pt-BR with fallbacks', () => {
    const row = jobHistoryRow({
      id: '7',
      printerKey: 'p1',
      outcome: 'cancelled',
      filename: 'a.gcode',
      printDurationSeconds: 3660,
      endedAt: Date.UTC(2026, 10, 15, 15, 0, 0),
    })
    expect(row).toMatchObject({
      outcome: 'Cancelado',
      filename: 'a.gcode',
      duration: '1 h 1 min',
    })
    expect(row.endedAt).toContain('15/11/2026')
    expect(
      jobHistoryRow({
        id: '8',
        printerKey: 'p',
        outcome: 'failed',
        endedAt: 0,
      }),
    ).toMatchObject({
      outcome: 'Falhou',
      filename: 'Arquivo desconhecido',
      duration: 'Não informada',
    })
    expect(
      jobHistoryRow({
        id: '9',
        printerKey: 'p',
        outcome: 'completed',
        totalDurationSeconds: 120,
        endedAt: 0,
      }).duration,
    ).toBe('0 h 2 min')
  })
  it('status: loading wins, error hides empty text, empty message otherwise', () => {
    expect(jobHistoryStatus({ pending: true, error: 'x', count: 0 })).toMatch(
      /Consultando/,
    )
    expect(jobHistoryStatus({ pending: false, error: 'x', count: 0 })).toBe('')
    expect(jobHistoryStatus({ pending: false, error: '', count: 0 })).toMatch(
      /Nenhum/,
    )
    expect(jobHistoryStatus({ pending: false, error: '', count: 2 })).toBe('')
  })
})
