import { expect, it, vi } from 'vitest'
import { getIntegrationPrinterStatus } from '../../apps/farm/server/utils/integration-printers.ts'

it('flags future printer status timestamps and preserves current timestamps', async () => {
  const id = 'aaaaaaaa-0000-4000-8000-000000000001'
  const farmId = 'aaaaaaaa-0000-4000-8000-000000000002'
  const principal = {
    appId: 'app',
    scopes: ['printers:read'],
    grants: [{ farmId, printerAssignmentId: null, scopes: ['printers:read'] }],
  } as never
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    for (const observedAt of [999, 1000, 1001]) {
      const row = {
        id,
        farmId,
        printerKey: 'simulator',
        sandbox: false,
        state: {
          printerKey: 'simulator',
          state: 'idle',
          progress: 0,
          observedAt,
        },
        observedAt,
      }
      const status = await getIntegrationPrinterStatus(
        principal,
        { readPrinter: async () => row },
        id,
      )
      if (observedAt > 1000) {
        expect(status).toHaveProperty('timestampSkewed', true)
        expect(status).not.toHaveProperty('observedAt')
      } else {
        expect(status).toHaveProperty('observedAt', observedAt)
        expect(status).not.toHaveProperty('timestampSkewed')
      }
    }
  } finally {
    clock.mockRestore()
  }
})
