import { expect, test } from 'vitest'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import { kobraXPrinterDetail } from '../../packages/connector/src/kobra-x/printer-detail.ts'
import {
  startKobraXMock,
  withNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'

test('Kobra X detail reflects native reports from the E16 loopback mock', async () => {
  await withNetworkGuard(async () => {
    const mock = await startKobraXMock({ reportIntervalMs: 0 })
    try {
      const adapter = await connectKobraX({
        address: '127.0.0.1',
        printerKey: 'kobra-x',
        clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
        httpPort: mock.httpPort,
        mqttPort: mock.mqttPort,
      })
      try {
        await expect.poll(() => adapter.snapshot().state).toBe('idle')
        const frame = kobraXPrinterDetail(adapter.snapshot(), 1)
        expect(frame?.detail.print?.state).toBe('idle')
        expect(frame?.vendor).toBe('kobra-x')
        expect(frame?.capabilities).toContain('job')
        await expect.poll(() => adapter.snapshot().fans?.part).toBe(0)
        const outputs = kobraXPrinterDetail(adapter.snapshot(), 2)
        expect(outputs?.detail.fans).toEqual([{ name: 'part', speed: 0 }])
        expect(outputs?.detail.lights?.[0]?.white).toBe(0)
        mock.control.seedFile('cube.gcode', 'G28')
        expect(await adapter.control.files.list()).toMatchObject({
          kind: 'confirmed',
          data: [{ filename: 'cube.gcode', sizeBytes: 3 }],
        })
        expect(frame?.capabilities).not.toContain('motion')
        expect(frame?.capabilities).not.toContain('webcams')
      } finally {
        await adapter.close()
      }
    } finally {
      await mock.close()
    }
  })
})
