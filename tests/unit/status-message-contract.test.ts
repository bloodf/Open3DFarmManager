import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import {
  TelemetryBatch,
  TELEMETRY_BATCH_JSON_LIMITS,
} from '../../packages/farm-protocol/src/telemetry.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import { formatPrinterStateLabel } from '../../apps/farm/app/utils/farm-view.ts'
import { printerReadiness } from '../../apps/farm/server/utils/integration-printers-readiness.ts'
import { getIntegrationPrinterStatus } from '../../apps/farm/server/utils/integration-printers.ts'

const state = {
  printerKey: 'p',
  state: 'error' as const,
  statusReason: 'firmware-shutdown' as const,
  statusMessage: '<script>alert(1)</script>',
  observedAt: 1,
}
const id = 'aaaaaaaa-0000-4000-8000-000000000001'
const farmId = 'aaaaaaaa-0000-4000-8000-000000000002'
const row = {
  id,
  farmId,
  printerKey: 'p',
  sandbox: false,
  state,
  observedAt: 1,
}

describe('firmware shutdown reader contract', () => {
  it('accepts shutdown without progress and bounds the message', () => {
    expect(
      PrinterState.safeParse({ ...state, statusMessage: 'x'.repeat(256) })
        .success,
    ).toBe(true)
    for (const statusMessage of ['', 'x'.repeat(257)])
      expect(PrinterState.safeParse({ ...state, statusMessage }).success).toBe(
        false,
      )
    expect(
      PrinterState.safeParse({ ...state, statusReason: undefined }).success,
    ).toBe(false)
    expect(
      PrinterState.safeParse({ ...state, state: 'printing' }).success,
    ).toBe(false)
  })
  it('exposes the reason and leaves unknown progress absent', async () => {
    expect(printerReadiness(row).degradedReason).toBe('firmware-shutdown')
    const principal = {
      appId: 'app',
      scopes: ['printers:read'],
      grants: [
        { farmId, printerAssignmentId: null, scopes: ['printers:read'] },
      ],
    } as never
    const result = await getIntegrationPrinterStatus(
      principal,
      { readPrinter: async () => row },
      id,
    )
    expect(result).toMatchObject({
      state: 'error',
      statusReason: 'firmware-shutdown',
    })
    expect(result).not.toHaveProperty('progress')
    expect(result).not.toHaveProperty('statusMessage')
  })
  it('renders firmware text escaped', async () => {
    const label = formatPrinterStateLabel(state)
    const html = await renderToString(
      createSSRApp({ render: () => h('p', label) }),
    )
    expect(html).toContain('Firmware desligado')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('documents the existing telemetry string limit conflict', () => {
    const batch = [
      {
        eventId: randomUUID(),
        queuedAt: 1,
        kind: 'printer-state' as const,
        state: { ...state, statusMessage: 'x'.repeat(256) },
      },
    ]
    expect(TelemetryBatch.safeParse(batch).success).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
      TELEMETRY_BATCH_JSON_LIMITS.maxBytes,
    )
    expect(() =>
      parseBoundedJson(JSON.stringify(batch), TELEMETRY_BATCH_JSON_LIMITS),
    ).toThrow()
  })
})
