import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverPrinters } from '../../packages/connector/src/discovery/index.ts'
import { collectableRuntime } from '../../packages/connector/src/runtime/configuration-snapshot.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { readPrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import { createSdcpCollection } from '../../packages/connector/src/runtime/sdcp-collection.ts'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'
import { status } from '../fixtures/sdcp/messages.ts'

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}
describe('SDCP runtime', () => {
  it('registers loopback discovery and collects fresh status, then withdraws stale data', async () => {
    const sim = await startSdcpSimulator()
    const abort = new AbortController()
    const observations: any[] = []
    const reasons: string[] = []
    try {
      const found = await discoverPrinters({
        timeout: 80,
        bindAddress: '127.0.0.1',
        bambuPorts: [],
        mdnsPort: 0,
        queryAddress: '127.0.0.1',
        queryPort: sim.discoveryPort,
        kobraX: false,
        sdcp: { target: '127.0.0.1', port: sim.discoveryPort },
      })
      expect(found).toContainEqual(
        expect.objectContaining({
          vendor: 'sdcp',
          host: '127.0.0.1',
          serial: 'fixture01',
        }),
      )
      sim.setStatus(status)
      const sub = createSdcpCollection({
        binding: {
          printerKey: 'resin',
          host: '127.0.0.1',
          mainboardId: 'fixture01',
          model: 'Saturn 4 Ultra',
        },
        signal: abort.signal,
        endpoints: {
          discoveryPort: sim.discoveryPort,
          websocketPort: sim.websocketPort,
          timeoutMs: 30,
          pollMs: 5,
          staleAfterMs: 100,
          retryMs: 500,
        },
        onObservation: (value) => observations.push(value),
        onUnavailable: (_epoch, reason) => reasons.push(reason),
      })
      try {
        await waitFor(() => observations.length > 0)
        expect(observations[0].printer).toMatchObject({
          state: 'printing',
          progress: 0.25,
          controls: [],
        })
        expect(sim.requests).toHaveLength(1)
        expect(sim.requests[0]).toMatchObject({
          Topic: 'sdcp/request/fixture01',
          Data: { Cmd: 0 },
        })
        await waitFor(() => reasons.includes('stale'))
      } finally {
        abort.abort()
        await sub.done
      }
    } finally {
      abort.abort()
      await sim.close()
    }
  })
  it('reports a protocol mismatch without opening a status connection', async () => {
    const sim = await startSdcpSimulator()
    const abort = new AbortController()
    const reasons: string[] = []
    sim.discovery.Data.ProtocolVersion = 'V2.0.0'
    try {
      const sub = createSdcpCollection({
        binding: {
          printerKey: 'resin',
          host: '127.0.0.1',
          mainboardId: 'fixture01',
          model: 'Saturn 4 Ultra',
        },
        signal: abort.signal,
        endpoints: {
          discoveryPort: sim.discoveryPort,
          websocketPort: sim.websocketPort,
          timeoutMs: 20,
          retryMs: 500,
        },
        onObservation: () => {
          throw new Error('Unexpected observation')
        },
        onUnavailable: (_epoch, reason) => reasons.push(reason),
      })
      try {
        await waitFor(() => reasons.length > 0)
        expect(reasons[0]).toContain('Unsupported SDCP protocol version')
        expect(sim.connected()).toBe(0)
      } finally {
        abort.abort()
        await sub.done
      }
    } finally {
      await sim.close()
    }
  })
  it('provisions only an unprivileged read-only assignment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdcp-config-'))
    try {
      const id = '00000000-0000-4000-8000-000000000001'
      const config = {
        version: 6,
        collection: {
          version: 6,
          allowedOrigins: [],
          printers: [],
          sdcp: {
            printers: [
              {
                printerKey: 'resin',
                host: '127.0.0.1',
                mainboardId: 'fixture01',
                model: 'Saturn 4 Ultra',
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
            backend: 'sdcp',
          },
        ],
        telemetry: {
          endpoint: 'https://example.test',
          audience: 'https://example.test',
        },
      }
      const path = join(dir, 'runtime.json')
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
      expect(collectableRuntime(config, new Set())).toMatchObject({
        version: 6,
      })
      expect(collectableRuntime(config, new Set([id]))).toBeNull()
      const runtime = readAgentRuntimeConfig(path, {
        agent_id: id,
        farm_id: id,
      })
      const handle = runtime.bindingFor(id)
      expect(handle).toBeDefined()
      expect(readPrinterBinding(handle!)).toBeNull()
      config.collection.sdcp.printers[0]!.model = 'Mars 4 Ultra'
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
      expect(() =>
        readAgentRuntimeConfig(path, { agent_id: id, farm_id: id }),
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
