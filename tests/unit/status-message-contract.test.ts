import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import {
  TelemetryBatch,
  TELEMETRY_BATCH_JSON_LIMITS,
} from '../../packages/farm-protocol/src/telemetry.ts'
import { StatusMessage } from '../../packages/farm-protocol/src/channel.ts'
import { READONLY_PENDING_BYTES } from '../../packages/connector/src/webrtc/readonly-peer.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import { formatPrinterStateLabel } from '../../apps/farm/app/utils/farm-view.ts'
import { parseStoredPrinterState } from '../../apps/farm/server/services/printer-states-core.ts'
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
    for (const otherState of [
      'idle',
      'printing',
      'paused',
      'unknown',
      'offline',
    ] as const)
      for (const progress of [undefined, 0.5])
        expect(
          PrinterState.safeParse({ ...state, state: otherState, progress })
            .success,
        ).toBe(false)
    expect(
      PrinterState.safeParse({ ...state, statusMessage: undefined }).success,
    ).toBe(true)
    expect(
      PrinterState.safeParse({ ...state, statusMessage: '\ud800' }).success,
    ).toBe(false)
    expect(
      PrinterState.safeParse({ ...state, statusMessage: 'fault\0detail' })
        .success,
    ).toBe(false)
    const message = 'Falha 🌡️\n' + 'x'.repeat(200)
    expect(
      PrinterState.parse({ ...state, statusMessage: message }).statusMessage,
    ).toBe(message)
  })
  it('exposes the reason and leaves unknown progress absent', async () => {
    expect(parseStoredPrinterState(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    )
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
  it('fits the status frame and telemetry bounds with a full message', () => {
    const populatedState = {
      ...state,
      printerKey: 'p'.repeat(128),
      statusMessage: '\u0001'.repeat(256),
      filename: 'f'.repeat(128),
      identity: {
        vendor: 'v'.repeat(128),
        model: 'm'.repeat(128),
        firmware: 'f'.repeat(128),
      },
      materials: Array.from({ length: 17 }, () => ({
        slot: 's'.repeat(32),
        materialType: 'm'.repeat(64),
        colorHex: 'FFFFFFFF',
        remainingPercent: 100,
        active: true,
      })),
      toolTargetsCelsius: Array.from({ length: 32 }, (_, tool) => ({
        tool,
        target: 300,
      })),
    }
    expect(PrinterState.safeParse(populatedState).success).toBe(true)
    const batch = [
      {
        eventId: randomUUID(),
        queuedAt: 1,
        kind: 'printer-state' as const,
        state: populatedState,
      },
    ]
    expect(TelemetryBatch.safeParse(batch).success).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
      TELEMETRY_BATCH_JSON_LIMITS.maxBytes,
    )
    expect(() =>
      parseBoundedJson(JSON.stringify(batch), TELEMETRY_BATCH_JSON_LIMITS),
    ).not.toThrow()
    const frame = { t: 'snapshot', seq: 1, printers: [batch[0]!.state] }
    expect(StatusMessage.safeParse(frame).success).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
      READONLY_PENDING_BYTES,
    )
  })
})
