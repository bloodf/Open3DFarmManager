import { describe, expect, it } from 'vitest'
import {
  connectFormlabs,
  isSupportedFormlabsModel,
} from '../../packages/connector/src/formlabs/index.ts'
import { startFormlabsSimulator } from '../../packages/sim-tools/src/formlabs-simulator.ts'
import { devices } from '../fixtures/formlabs/devices.ts'

describe('PreForm local status', () => {
  it('reads device list, identifies unsupported models, expires retrieved data and refuses commands', async () => {
    const sim = await startFormlabsSimulator()
    let now = 100
    try {
      sim.setResponse(devices)
      const adapter = connectFormlabs({
        host: '127.0.0.1',
        port: sim.port,
        now: () => now,
        staleAfterMs: 10,
      })
      const result = await adapter.refresh()
      expect(result.devices).toHaveLength(2)
      expect(result.printerObservedAt).toBeNull()
      expect(isSupportedFormlabsModel(result.devices[0]!.product_name)).toBe(
        true,
      )
      expect(isSupportedFormlabsModel(result.devices[1]!.product_name)).toBe(
        false,
      )
      expect(adapter.command({ action: 'print' })).toEqual({
        ok: false,
        reason: 'unsupported',
      })
      now += 10
      expect(adapter.snapshot()).toBeUndefined()
      expect(sim.requests).toEqual(['GET /devices/'])
      sim.setResponse({}, 503)
      await expect(adapter.refresh()).rejects.toThrow()
      expect(adapter.snapshot()).toBeUndefined()
    } finally {
      await sim.close()
    }
  })
})
