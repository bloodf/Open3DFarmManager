import { createApp, defineEventHandler, toWebHandler, toWebRequest } from 'h3'
import { describe, expect, it, vi } from 'vitest'

vi.mock('nuxt/server', () => ({
  defineEventHandler: (handler: unknown) => handler,
  useRuntimeConfig: () => ({ auth: {} }),
}))
vi.mock('../../apps/farm/server/utils/integration-auth-runtime.ts', () => ({
  integrationAuthPool: () => ({}),
}))
const manage = vi.hoisted(() =>
  vi.fn(async (): Promise<{ value: null } | null> => ({ value: null })),
)
vi.mock('../../apps/farm/server/storage/alert-rules-postgres.ts', () => ({
  alertRulesStore: () => ({ manage }),
}))

// Load the Nitro handler through Vitest so the Node test project does not need
// Nitro's generated runtime-config declarations.
const { alertSettingsHandler } = await vi.importActual<{
  alertSettingsHandler: (
    operation: 'test-channel',
  ) => (event: {
    req: Request
    res: { headers: Headers }
    context: object
  }) => Promise<Response>
}>('../../apps/farm/server/utils/integration-alert-rules-http.ts')

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
    })
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
    const bom = await fetch(
      new Request('http://localhost/test', {
        method: 'POST',
        body: new Uint8Array([0xef, 0xbb, 0xbf]),
      }),
    )
    expect(bom.status).toBe(400)
  })

  it('returns 403 when a formerly authorized grant is denied by the store', async () => {
    manage.mockResolvedValueOnce(null)
    const response = await fetch(
      new Request('http://localhost/test', { method: 'POST' }),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'insufficient-scope' })
  })
})
