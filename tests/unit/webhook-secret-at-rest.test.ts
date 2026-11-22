import { createHmac, timingSafeEqual } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PostgresWebhooks } from '../../apps/farm/server/storage/webhook-postgres.ts'
import { credentialKeyring } from '../../apps/farm/server/utils/sealed-credential-key.ts'
import {
  openWebhookSecret,
  sealWebhookSecret,
} from '../../apps/farm/server/utils/webhooks/secret.ts'

describe('webhook signing secret at rest', () => {
  it('stores an encrypted secret and returns the usable key only for delivery', async () => {
    const secret = 'webhook-secret-that-must-not-be-stored'
    const statements: unknown[][] = []
    const sql = Object.assign(
      vi.fn(async (...args: unknown[]) => {
        statements.push(args)
        return [{ allowed: true, full: false }]
      }),
      {
        begin: async (fn: (tx: typeof sql) => unknown) => fn(sql),
        json: (value: unknown) => value,
      },
    )
    const master = credentialKeyring({
      credentialEncryptionKey: 'x'.repeat(32),
      sessionSecret: 'y'.repeat(32),
    })
    const store = new PostgresWebhooks(sql as never, master)
    const created = await store.create('app-id', {
      url: 'https://example.com',
      events: [],
    })
    if (typeof created === 'string') throw new Error(created)
    const returnedSecret = created.signingSecret
    expect(returnedSecret).toBeTruthy()
    const insert = statements.find((statement) =>
      String(statement[0]).includes('INSERT INTO farm.integration_webhooks'),
    )
    expect(insert).toBeDefined()
    expect(JSON.stringify(insert)).not.toContain(returnedSecret)
    expect(String(insert![0])).toContain('signing_secret')
    const secretBinding = insert!
      .slice(1)
      .find((value) => typeof value === 'string' && value.startsWith('O3W1.'))
    expect(secretBinding).toBeTypeOf('string')
    const persistedDelivery = openWebhookSecret(String(secretBinding), master)
    expect(persistedDelivery.secret).toBe(returnedSecret)

    const sealed = sealWebhookSecret(returnedSecret, master)
    expect(sealed).not.toContain(returnedSecret)
    const delivery = openWebhookSecret(sealed, master)
    expect(delivery.secret).toBe(returnedSecret)
    const timestamp = '123'
    const body = '{}'
    const expected = createHmac('sha256', returnedSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
    const actual = createHmac('sha256', delivery.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
    expect(timingSafeEqual(Buffer.from(expected), Buffer.from(actual))).toBe(
      true,
    )
    const persistedActual = createHmac('sha256', persistedDelivery.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
    expect(
      timingSafeEqual(Buffer.from(expected), Buffer.from(persistedActual)),
    ).toBe(true)
  })
})
