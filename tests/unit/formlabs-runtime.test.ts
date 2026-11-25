import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { readPrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import { collectableRuntime } from '../../packages/connector/src/runtime/configuration-snapshot.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { createFormlabsCollection } from '../../packages/connector/src/runtime/formlabs-collection.ts'
import { startFormlabsSimulator } from '../../packages/sim-tools/src/formlabs-simulator.ts'
import { devices } from '../fixtures/formlabs/devices.ts'

describe('Formlabs collection', () => {
  it('provisions only a read-only handle and hides unconfirmed assignments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'formlabs-config-'))
    try {
      const id = '00000000-0000-4000-8000-000000000001'
      const config = {
        version: 7,
        collection: {
          version: 7,
          allowedOrigins: [],
          printers: [],
          formlabs: {
            printers: [
              {
                printerKey: 'resin',
                host: '127.0.0.1',
                port: 44388,
                deviceId: 'Form4-Example',
                model: 'Form 4',
              },
            ],
          },
        },
        assignments: [
          {
            assignment_id: id,
            farm_id: id,
            agent_id: id,
            printer_key: 'resin',
            backend: 'formlabs',
          },
        ],
        telemetry: {
          endpoint: 'https://example.test',
          audience: 'https://example.test',
        },
      }
      const path = join(dir, 'runtime.json')
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
      expect(collectableRuntime(config, new Set([id]))).toBeNull()
      const runtime = readAgentRuntimeConfig(path, {
        farm_id: id,
        agent_id: id,
      })
      expect(readPrinterBinding(runtime.bindingFor(id)!)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('publishes host status, withdraws on 503 and resumes in a new epoch', async () => {
    const sim = await startFormlabsSimulator()
    const abort = new AbortController()
    const events: unknown[] = []
    const observations: RawPrinterObservation[] = []
    sim.setResponse(devices)
    const sub = createFormlabsCollection({
      binding: {
        printerKey: 'resin',
        host: '127.0.0.1',
        port: sim.port,
        deviceId: 'Form4-Example',
        model: 'Form 4',
      },
      signal: abort.signal,
      pollMs: 10,
      onObservation: (observation) => {
        observations.push(observation)
        const { epoch, printer } = observation
        events.push({
          epoch,
          state: printer.state,
          status: printer.preformStatus,
          progress: printer.progress,
          remaining: printer.estimatedRemainingSeconds,
          identity: printer.identity,
        })
        if (epoch === 1) sim.setResponse({}, 503)
        else abort.abort()
      },
      onUnavailable: (epoch, reason) => {
        events.push({ epoch, reason })
        sim.setResponse({
          count: 1,
          devices: [
            {
              ...devices.devices[0],
              status: 'Idle',
              estimated_print_time_remaining_ms: 0,
            },
          ],
        })
      },
    })
    try {
      await expect.poll(() => events.length).toBe(3)
      expect(events).toEqual([
        {
          epoch: 1,
          state: 'unknown',
          status: 'Printing',
          progress: undefined,
          remaining: 5400,
          identity: { vendor: 'Formlabs', model: 'Form 4', firmware: '1.0' },
        },
        { epoch: 1, reason: 'PreForm host unavailable' },
        {
          epoch: 2,
          state: 'unknown',
          status: 'Idle',
          progress: undefined,
          remaining: undefined,
          identity: { vendor: 'Formlabs', model: 'Form 4', firmware: '1.0' },
        },
      ])
      expect(
        observations.map(({ fieldObservedAtMonoMs, receivedAtMonoMs: at }) => [
          fieldObservedAtMonoMs,
          at,
        ]),
      ).toEqual(
        observations.map(({ receivedAtMonoMs: at }, index) => [
          {
            formlabs: {
              state: at,
              preformStatus: at,
              identity: at,
              ...(index === 0 ? { estimatedRemainingSeconds: at } : {}),
            },
          },
          at,
        ]),
      )
      expect(sim.deviceResponseStatuses).toEqual([200, 503, 200])
      expect(sim.requests).toEqual(Array(3).fill('GET /devices/'))
    } finally {
      abort.abort()
      await sub.done
      await sim.close()
    }
  })
  it('withholds a reading when the host reports a model other than the bound one', async () => {
    const sim = await startFormlabsSimulator()
    const abort = new AbortController()
    const reasons: string[] = []
    const observations: RawPrinterObservation[] = []
    sim.setResponse(devices)
    const sub = createFormlabsCollection({
      binding: {
        printerKey: 'resin',
        host: '127.0.0.1',
        port: sim.port,
        deviceId: 'Form4-Example',
        model: 'Form 4L',
      },
      signal: abort.signal,
      pollMs: 10,
      onObservation: (observation) => observations.push(observation),
      onUnavailable: (_epoch, reason) => {
        reasons.push(reason)
        abort.abort()
      },
    })
    try {
      await sub.done
      expect(reasons).toEqual(['model mismatch'])
      expect(observations).toEqual([])
    } finally {
      abort.abort()
      await sim.close()
    }
  })
  it('drops a malformed remaining-time field and keeps the host status', async () => {
    const sim = await startFormlabsSimulator()
    const abort = new AbortController()
    const observations: RawPrinterObservation[] = []
    sim.setResponse({
      count: 1,
      devices: [
        {
          ...devices.devices[0],
          product_name: 'form 4',
          estimated_print_time_remaining_ms: -1,
        },
      ],
    })
    const sub = createFormlabsCollection({
      binding: {
        printerKey: 'resin',
        host: '127.0.0.1',
        port: sim.port,
        deviceId: 'Form4-Example',
        model: 'Form 4',
      },
      signal: abort.signal,
      pollMs: 10,
      onObservation: (observation) => {
        observations.push(observation)
        abort.abort()
      },
      onUnavailable: () => abort.abort(),
    })
    try {
      await sub.done
      expect(observations).toHaveLength(1)
      const printer = observations[0]!.printer
      expect(printer.preformStatus).toBe('Printing')
      expect(printer.identity?.model).toBe('Form 4')
      expect('estimatedRemainingSeconds' in printer).toBe(false)
    } finally {
      abort.abort()
      await sim.close()
    }
  })
})
