import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { readPrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import { collectableRuntime } from '../../packages/connector/src/runtime/configuration-snapshot.ts'
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
  it('withdraws a cached reading with unknown observation time', async () => {
    const sim = await startFormlabsSimulator()
    const abort = new AbortController()
    const reasons: string[] = []
    sim.setResponse(devices)
    const sub = createFormlabsCollection({
      binding: {
        printerKey: 'resin',
        host: '127.0.0.1',
        port: sim.port,
        deviceId: 'Form4-Example',
      },
      signal: abort.signal,
      pollMs: 10,
      onObservation: () => {
        throw Error('Unexpected fresh telemetry')
      },
      onUnavailable: (_epoch, reason) => reasons.push(reason),
    })
    try {
      for (let i = 0; i < 100 && !reasons.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      expect(reasons).toContain('printer observation time unknown')
      expect(sim.requests).toEqual(['GET /devices/'])
    } finally {
      abort.abort()
      await sub.done
      await sim.close()
    }
  })
})
