import { createApp, defineEventHandler, toWebHandler, toWebRequest } from 'h3'
import { describe, expect, it, vi } from 'vitest'

vi.mock('nuxt/server', () => ({
  defineEventHandler: (handler: unknown) => handler,
  useRuntimeConfig: () => ({ auth: {} }),
}))
vi.mock('../../apps/farm/server/storage/alert-rules-postgres.ts', () => ({
  alertRulesStore: () => ({ manage: async () => ({ value: null }) }),
}))

import { alertSettingsHandler } from '../../apps/farm/server/utils/integration-alert-rules-http.ts'

const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const app = createApp()
const handler = alertSettingsHandler('test-channel')
app.use(
  defineEventHandler(async (event) => {
    const request = toWebRequest(event)
    return handler({
      req: request,
      res: { headers: new Headers() },
      context: {
        params: { farmId },
        integrationAuth: {
          appId: farmId,
          grants: [
            {
              id: farmId,
              farmId,
              printerAssignmentId: null,
              scopes: ['alerts:manage'],
              requiresApproval: false,
            },
          ],
        },
      },
    } as never)
  }),
)
const fetch = toWebHandler(app)

describe('notification test body', () => {
  it('accepts an empty POST stream and rejects a non-empty one', async () => {
    const empty = await fetch(
      new Request('http://localhost/test', {
        method: 'POST',
        body: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        duplex: 'half',
      } as RequestInit),
    )
    expect(empty.status).toBe(404)
    const nonempty = await fetch(
      new Request('http://localhost/test', { method: 'POST', body: '{}' }),
    )
    expect(nonempty.status).toBe(400)
  })
})
