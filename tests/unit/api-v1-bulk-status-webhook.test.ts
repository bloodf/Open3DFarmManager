import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('nuxt/server', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).nuxtServer(),
)
vi.mock('../../apps/farm/server/utils/integration-auth-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).authRuntime(),
)
vi.mock('../../apps/farm/server/utils/integration-jobs-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).jobsRuntime(),
)
vi.mock(
  '../../apps/farm/server/services/signalling-runtime-bootstrap.ts',
  async () =>
    (await import('../helpers/api-v1-contract/mocks.ts')).signalling(),
)
vi.mock(
  '../../apps/farm/server/storage/webhook-postgres.ts',
  async (original) =>
    (await import('../helpers/api-v1-contract/mocks.ts')).webhookStorage(
      original as never,
    ),
)

import type { IntegrationPrinterRow } from '../../apps/farm/server/utils/integration-auth.ts'
import {
  buildPrinterAlertRaisedEvent,
  newlyRaisedAlerts,
  signPrinterAlertWebhook,
  verifyWebhookSignature,
} from '../../apps/farm/server/utils/webhooks/printer-alerts.ts'
import { call } from '../helpers/api-v1-contract/router.ts'
import { tokenFor } from '../helpers/api-v1-contract/scenarios.ts'
import { freshWorld, ids } from '../helpers/api-v1-contract/world.ts'

async function asToken(
  world: ReturnType<typeof freshWorld>,
  scopes: ('printers:read' | 'events:subscribe' | 'inventory:read')[],
  printerId?: string | null,
) {
  const app = world.addApp([{ scopes, printerId: printerId ?? null }])
  return { app, token: await tokenFor(world, app) }
}

describe('GET /printers/status', () => {
  it('refuses a token without printers:read', async () => {
    const world = freshWorld()
    const { token } = await asToken(world, ['inventory:read'])
    const denied = await call({
      method: 'GET',
      path: '/printers/status',
      token,
    })
    expect(denied.status).toBe(403)
    expect(denied.json).toMatchObject({ code: 'insufficient-scope' })
  })

  it('returns only printers covered by the grant', async () => {
    const world = freshWorld()
    const { token } = await asToken(world, ['printers:read'], ids.printerA1)
    const listed = await call({
      method: 'GET',
      path: '/printers/status',
      token,
    })
    expect(listed.status).toBe(200)
    const body = listed.json as {
      data: { printerId: string; displayName?: string; alerts: unknown[] }[]
      nextCursor: string | null
    }
    expect(body.data.map((row) => row.printerId)).toEqual([ids.printerA1])
    expect(body.data[0]).toMatchObject({
      printerId: ids.printerA1,
      displayName: 'Alpha',
      groupName: 'Linha A',
      location: 'Sala 1',
      state: 'printing',
      estimatedRemainingSeconds: 60,
    })
    expect(Array.isArray(body.data[0]!.alerts)).toBe(true)
    expect(body.nextCursor).toBeNull()
  })

  it('omits printers of another farm when farmId is set', async () => {
    const world = freshWorld()
    const { token } = await asToken(world, ['printers:read'])
    const listed = await call({
      method: 'GET',
      path: `/printers/status?farmId=${ids.farmA}`,
      token,
    })
    expect(listed.status).toBe(200)
    const idsReturned = (
      listed.json as { data: { printerId: string }[] }
    ).data.map((row) => row.printerId)
    expect(idsReturned).toEqual([ids.printerA1, ids.printerA2])
    expect(idsReturned).not.toContain(ids.printerB1)
  })
})

describe('printer.alert.raised webhook', () => {
  it('signs the payload so OpenFarm-Signature verifies', () => {
    const row: IntegrationPrinterRow = {
      id: ids.printerA1,
      farmId: ids.farmA,
      agentId: ids.agentA,
      printerKey: 'printer-a1',
      displayName: 'Alpha',
      sandbox: false,
      state: {
        printerKey: 'printer-a1',
        state: 'error',
        progress: 0,
        observedAt: 1_700_000_000_000,
      },
      observedAt: 1_700_000_000_000,
    }
    const [alert] = newlyRaisedAlerts(null, row)
    expect(alert?.kind).toBe('error')
    const event = buildPrinterAlertRaisedEvent(row, alert!)
    const secret = 'test-signing-secret-for-alerts'
    const now = 1_700_000_100_000
    const { body, headers } = signPrinterAlertWebhook(event, secret, now)
    expect(headers['OpenFarm-Event-Id']).toBe(event.id)
    expect(headers['OpenFarm-Timestamp']).toBe(String(now / 1000))
    expect(headers['OpenFarm-Signature']).toBe(
      'v1=' +
        createHmac('sha256', secret)
          .update(`${now / 1000}.${body}`)
          .digest('hex'),
    )
    expect(
      verifyWebhookSignature(
        secret,
        body,
        headers['OpenFarm-Timestamp'],
        headers['OpenFarm-Signature'],
      ),
    ).toBe(true)
    expect(
      verifyWebhookSignature(
        secret,
        body,
        headers['OpenFarm-Timestamp'],
        'v1=' + '00'.repeat(32),
      ),
    ).toBe(false)
  })

  it('refuses creating a webhook without events:subscribe', async () => {
    const world = freshWorld()
    const { token } = await asToken(world, ['printers:read'])
    const denied = await call({
      method: 'POST',
      path: '/webhooks',
      token,
      body: {
        url: 'https://8.8.8.8/hook',
        events: ['printer.alert.raised'],
      },
    })
    expect(denied.status).toBe(403)
    expect(denied.json).toMatchObject({ code: 'insufficient-scope' })
  })

  it('accepts a sandbox subscription to printer.alert.raised', async () => {
    const world = freshWorld()
    const app = world.addApp([{ scopes: ['events:subscribe'] }], {
      sandbox: true,
    })
    const token = await tokenFor(world, app)
    const created = await call({
      method: 'POST',
      path: '/webhooks',
      token,
      body: {
        url: 'https://127.0.0.1:8123/alerts',
        events: ['printer.alert.raised'],
      },
    })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({
      events: ['printer.alert.raised'],
    })
    expect(
      typeof (created.json as { signingSecret?: string }).signingSecret,
    ).toBe('string')
  })
})
