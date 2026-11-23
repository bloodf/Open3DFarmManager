import type { Sql } from 'postgres'
import { expect, it, vi } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import { parseLastKnownStates } from '../../apps/farm/app/composables/useLastKnownStates-core.ts'
import { parseStatusSummary } from '../../apps/farm/app/utils/status-summary.ts'
import { projectPrinterState } from '../../apps/farm/server/services/printer-states-core.ts'
import {
  buildStatusSummary,
  summaryEtag,
} from '../../apps/farm/server/services/status-summary.ts'
import { PostgresPrinterStateReader } from '../../apps/farm/server/storage/postgres-printer-state-reader.ts'

vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: vi.fn(),
  authenticatedSession: vi.fn(),
  sealedSessionRecordId: vi.fn(),
}))

const farmId = '11111111-1111-4111-8111-111111111111'
const assignmentId = '22222222-2222-4222-8222-222222222222'
const now = 1_700_000_000_000
const printerKey = 'bambu'
const alarms = {
  printError: '0300-8005',
  hmsCount: 1,
  hmsCode: '0500-0200-0002-0001',
}
const printer = {
  printerKey,
  state: 'printing' as const,
  progress: 0.25,
  observedAt: now - 1000,
}
const row = {
  ...printer,
  assignmentId,
  alarms,
  toolTemperatureCelsius: undefined,
  bedTemperatureCelsius: undefined,
}
const stored = {
  ...printer,
  assignmentId,
  temperatures: {},
  alarms,
}
const summary = {
  generatedAt: now,
  total: 1,
  counts: { printing: 1 },
  truncated: false,
  printers: [stored],
}
const alarmLabel =
  'Imprimindo — Erro de impressão: 0300-8005 — Alertas HMS: 1 (0500-0200-0002-0001)'

it('retains bounded alarm data when reading the latest state for an assignment', async () => {
  const tx = vi.fn(async (query: TemplateStringsArray) => {
    const statement = query.join('')
    if (statement.includes('FROM farm.session_accounts'))
      return [{ id: 'account', sessionVersion: 1, disabled: false }]
    if (statement.includes('FROM farm.account_sessions'))
      return [
        {
          id: 'session',
          accountId: 'account',
          accountVersion: 1,
          createdAt: now - 2000,
          lastSeenAt: now - 1000,
          absoluteExpiresAt: now + 100_000,
          revokedAt: null,
        },
      ]
    if (statement.includes('FROM farm.memberships'))
      return [{ revoked_at: null }]
    if (statement.includes('FROM farm.printer_assignments'))
      return [{ assignmentId, printerKey, state: { ...printer, alarms } }]
    return []
  })
  const sql = { begin: async (run: (fn: typeof tx) => unknown) => run(tx) }
  const reader = new PostgresPrinterStateReader(
    sql as unknown as Sql,
    () => now,
  )

  expect(
    await reader.list({
      farmId,
      sessionRecordId: 'session',
      policy: { idleTimeoutMs: 100_000 },
    }),
  ).toEqual({ ok: true, states: [row] })
})

it('publishes an alarm in the last-known state projection', () => {
  expect(projectPrinterState(row)).toMatchObject({ state: 'printing', alarms })
  const { alarms: _alarms, ...legacy } = row
  expect(projectPrinterState(legacy)).not.toHaveProperty('alarms')
})

it('publishes an alarm in the overview projection and revalidates alarm changes', () => {
  const changed = { ...row, alarms: { ...alarms, printError: null } }
  const published = buildStatusSummary([row], now)
  expect(published).toMatchObject({
    counts: { printing: 1 },
    printers: [{ state: 'printing', alarms }],
  })
  expect(summaryEtag(buildStatusSummary([changed], now))).not.toBe(
    summaryEtag(published),
  )
})

it('shows an alarm from the last-known wire response on the read-only card', async () => {
  const parsed = parseLastKnownStates({ states: [stored] })
  expect(parsed).toMatchObject({ ok: true, states: [{ alarms }] })
  if (!parsed.ok) throw new Error('Expected a stored printer state')
  const html = await renderFarmComponent('LastKnownStates.vue', {
    state: parsed.states[0],
    nowWallMs: now,
  })
  expect(html).toContain(alarmLabel)
  expect(html).toContain('Somente leitura')
})

it('shows an alarm from the status summary wire response on the kiosk', async () => {
  const parsed = parseStatusSummary(summary)
  expect(parsed).toMatchObject({ ok: true, summary: { states: [{ alarms }] } })
  if (!parsed.ok) throw new Error('Expected a status summary')
  const html = await renderFarmComponent('PrinterKiosk.vue', {
    states: parsed.summary.states,
    nowWallMs: now,
    fetchedAt: now,
  })
  expect(html).toContain(alarmLabel)
})

it('rejects an oversized alarm summary received by either read-only view', () => {
  const invalid = { ...stored, alarms: { ...alarms, hmsCount: 65 } }
  const unavailable = { ok: false, reason: 'unavailable' }
  expect(parseStatusSummary({ ...summary, printers: [invalid] })).toEqual(
    unavailable,
  )
  expect(parseLastKnownStates({ states: [invalid] })).toEqual(unavailable)
})
