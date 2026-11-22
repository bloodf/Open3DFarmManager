import { describe, expect, it } from 'vitest'
import {
  discoverSdcp,
  parseSdcpDiscovery,
} from '../../packages/connector/src/discovery/sdcp.ts'
import { connectSdcp } from '../../packages/connector/src/sdcp/index.ts'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'
import { status } from '../fixtures/sdcp/messages.ts'

describe('SDCP read-only status', () => {
  it('discovers, rejects incompatible versions and exposes only fresh progress', async () => {
    const simulator = await startSdcpSimulator()
    try {
      const [identity] = await discoverSdcp({
        target: '127.0.0.1',
        port: simulator.discoveryPort,
        timeoutMs: 50,
      })
      expect(identity).toBeDefined()
      expect(
        parseSdcpDiscovery(
          Buffer.from(
            JSON.stringify({
              ...simulator.discovery,
              Data: {
                ...simulator.discovery.Data,
                MachineName: 'Mars 4 Ultra',
              },
            }),
          ),
          '127.0.0.1',
        ),
      ).toBeUndefined()
      expect(() =>
        connectSdcp({ ...identity!, protocolVersion: 'V2.0.0' }),
      ).toThrow('Unsupported SDCP protocol version')
      let now = 1000
      const adapter = connectSdcp(identity!, {
        port: simulator.websocketPort,
        staleAfterMs: 100,
        now: () => now,
      })
      try {
        for (let i = 0; i < 100 && !simulator.connected(); i++)
          await new Promise((resolve) => setTimeout(resolve, 5))
        expect(simulator.connected()).toBe(1)
        simulator.publish(status)
        for (let i = 0; i < 100 && !adapter.snapshot(); i++)
          await new Promise((resolve) => setTimeout(resolve, 5))
        expect(adapter.snapshot()).toMatchObject({
          state: 'printing',
          currentLayer: 25,
          totalLayer: 100,
          progress: 0.25,
        })
        expect(adapter.command('start')).toEqual({
          ok: false,
          reason: 'unsupported',
        })
        expect(adapter.capabilities).toEqual({
          status: true,
          dispatch: false,
          control: false,
        })
        now += 100
        expect(adapter.snapshot()).toBeUndefined()
      } finally {
        adapter.close()
      }
    } finally {
      await simulator.close()
    }
  })
})
