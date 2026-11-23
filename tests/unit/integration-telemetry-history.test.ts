// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { describe, expect, test } from 'vitest'
import {
  historyRange,
  projectHealth,
  projectHistory,
  projectTransitions,
} from '../../apps/farm/server/utils/integration-telemetry.ts'

describe('integration telemetry projections', () => {
  test('projects bounded transition diagnostics without private payload fields', () => {
    expect(
      projectTransitions([
        {
          transition: {
            printerKey: 'sim',
            from: 'printing',
            to: 'error',
            observedAt: 1000,
          },
          secret: 'hidden',
        },
        {
          transition: {
            printerKey: 'sim',
            from: 'error',
            to: 'offline',
            observedAt: 2000,
            reason: 'client-certificate-missing',
          },
        },
      ]),
    ).toEqual({
      events: [
        { from: 'printing', to: 'error', observedAt: 1000 },
        {
          from: 'error',
          to: 'offline',
          observedAt: 2000,
          reason: 'client-certificate-missing',
        },
      ],
      eventsTruncated: false,
    })
  })
  test('bounds history and rejects ambiguous parameters', () => {
    expect(
      historyRange(new URLSearchParams('since=0&until=1000&limit=2'), 1000),
    ).toEqual({ since: 0, until: 1000, limit: 2 })
    expect(
      historyRange(
        new URLSearchParams('since=0&until=1000&limit=2&limit=3'),
        1000,
      ),
    ).toBeNull()
    expect(
      historyRange(new URLSearchParams('since=0&until=604800001'), 604800001),
    ).toBeNull()
  })
  test('preserves unknown energy and reports offline and stale periods as gaps', () => {
    const data = projectHistory(
      [
        {
          state: {
            printerKey: 'sim',
            state: 'printing',
            progress: 0,
            currentLayer: 0,
            observedAt: 1000,
            toolTemperatureCelsius: 0,
            fans: { chamber: 0 },
          },
        },
        { state: { printerKey: 'sim', state: 'offline', observedAt: 3000 } },
      ],
      0,
      200000,
    )
    expect(data.metrics).toEqual([
      {
        observedAt: 1000,
        progress: { value: 0, unit: 'ratio' },
        toolTemperature: { value: 0, unit: '°C' },
        chamberFan: { value: 0, unit: '%' },
        currentLayer: 0,
      },
    ])
    expect(data.intervals).toEqual([
      { from: 0, until: 1000, state: 'gap' },
      { from: 1000, until: 3000, state: 'printing' },
      { from: 3000, until: 123000, state: 'gap' },
      { from: 123000, until: 200000, state: 'gap' },
    ])
  })
  test('uses a fresh preceding observation for the window without returning it as a metric', () => {
    const data = projectHistory(
      [
        {
          state: {
            printerKey: 'sim',
            state: 'printing',
            progress: 0,
            observedAt: 1000,
          },
        },
      ],
      2000,
      130000,
    )
    expect(data.metrics).toEqual([])
    expect(data.intervals).toEqual([
      { from: 2000, until: 121000, state: 'printing' },
      { from: 121000, until: 130000, state: 'gap' },
    ])
  })
  test('distinguishes a disconnected connector from an idle assignment', () => {
    const heartbeat = {
      lastSeenAt: 1000,
      health: {
        connector: {
          version: 'sim',
          uptimeMs: 1,
          queueBacklog: 0,
          storage: 'healthy',
          rtcScope: 'lan',
        },
        printers: [
          {
            printerKey: 'sim',
            state: 'connected',
            lastSuccessAt: 1000,
            p50Ms: null,
            p95Ms: null,
            reconnects: 0,
            lastErrorCode: null,
          },
        ],
      },
    }
    expect(projectHealth(heartbeat, 'sim', 1001)).toMatchObject({
      connector: 'connected',
      assignment: 'connected',
      degraded: false,
    })
    expect(
      projectHealth({ ...heartbeat, lastSeenAt: 200000 }, 'sim', 200001),
    ).toMatchObject({
      connector: 'connected',
      assignment: 'unknown',
      degraded: true,
      reasons: ['assignment-stale'],
      assignmentObservedAt: 1000,
    })
    expect(projectHealth(heartbeat, 'sim', 200000)).toMatchObject({
      connector: 'unknown',
      assignment: 'unknown',
      degraded: true,
      reasons: ['connector-stale'],
    })
  })
})
