import { EventEmitter } from 'node:events'
import { request } from 'node:https'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverNotificationTest } from '../../apps/farm/server/utils/alert-rules/delivery.ts'
import { verifyWebhookSignature } from '../../apps/farm/server/utils/webhooks/printer-alerts.ts'

vi.mock('node:https', () => ({ request: vi.fn() }))

// Spec-derived sandbox fixture. HTTPS is mocked and no sockets are opened.
const channel = {
  url: 'https://1.1.1.1/farm-notifications',
  secret: 'sandbox-fixture-signing-secret-123456',
}
const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('farm notification test', () => {
  beforeEach(() => vi.resetAllMocks())

  it.each([
    [204, 'delivered'],
    [302, 'failed'],
    [503, 'failed'],
    [undefined, 'failed'],
  ])(
    'reports receiver status %s as %s in one attempt',
    async (status, expected) => {
      const outbound = new EventEmitter()
      const end = vi.fn((body: string) => {
        expect(JSON.parse(body)).toMatchObject({
          type: 'farm.notification.test',
          data: { farmId },
        })
        expect(body).not.toContain(channel.secret)
        const options = vi.mocked(request).mock.calls[0]?.[0] as unknown as {
          headers: Record<string, string>
        }
        expect(
          verifyWebhookSignature(
            channel.secret,
            body,
            options.headers['OpenFarm-Timestamp']!,
            options.headers['OpenFarm-Signature']!,
          ),
        ).toBe(true)
        if (status === undefined)
          outbound.emit('error', new Error('socket unavailable'))
      })
      vi.mocked(request).mockImplementation((...args) => {
        const onResponse = args[1] as (response: unknown) => void
        if (status !== undefined)
          queueMicrotask(() =>
            onResponse({ statusCode: status, destroy: vi.fn() }),
          )
        return Object.assign(outbound, { end }) as unknown as ReturnType<
          typeof request
        >
      })

      await expect(deliverNotificationTest(farmId, channel)).resolves.toEqual({
        attempted: true,
        status: expected,
      })
      expect(end).toHaveBeenCalledOnce()
      expect(request).toHaveBeenCalledOnce()
    },
  )

  it('reports no attempt for a private destination', async () => {
    await expect(
      deliverNotificationTest(farmId, {
        ...channel,
        url: 'https://127.0.0.1/test',
      }),
    ).resolves.toEqual({ attempted: false, status: 'not-run' })
    expect(request).not.toHaveBeenCalled()
  })
})
