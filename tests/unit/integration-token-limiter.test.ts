import { describe, expect, it, vi } from 'vitest'
import { integrationTokenRequest } from '../../apps/farm/server/utils/integration-auth-http.ts'
import { IntegrationLimits } from '../../apps/farm/server/utils/integration-auth-limits.ts'

function tokenRequest(clientId: string, source = '192.0.2.1') {
  return new Request('http://localhost/api/integrations/v1/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': source,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: 'secret',
    }),
  })
}

describe('integration token limiter', () => {
  it('keeps a valid client able to obtain a token after unknown client traffic', async () => {
    const rateLimits = new IntegrationLimits()
    const issue = vi.fn(async () => ({
      access_token: 'token',
      token_type: 'Bearer',
      expires_in: 60,
      scope: '',
    }))
    const runtime = () =>
      ({
        store: {
          findActiveCredential: vi.fn(async (id: string) =>
            id === 'real-client'
              ? { id: 'credential', appId: 'app', secretHash: 'hash' }
              : null,
          ),
        },
        issue,
      }) as never

    for (let index = 0; index < 10_001; index++) {
      await integrationTokenRequest(
        tokenRequest(
          `random-${index}`,
          `192.0.${Math.floor(index / 256)}.${index % 256}`,
        ),
        runtime,
        rateLimits,
      )
    }

    const response = await integrationTokenRequest(
      tokenRequest('real-client'),
      runtime,
      rateLimits,
    )
    expect(response.status).toBe(200)
  })

  it('evicts the oldest bucket when the map reaches capacity', () => {
    let now = 0
    const limits = new IntegrationLimits(() => now)
    for (let index = 0; index < 10_000; index++)
      for (let attempt = 0; attempt < 30; attempt++)
        limits.take(`client-${index}`, 30)
    expect(limits.take('new-client', 30).allowed).toBe(true)
    expect(limits.take('client-0', 30)).toMatchObject({
      allowed: true,
      remaining: 29,
    })
    expect(limits.take('client-9999', 30)).toMatchObject({
      allowed: false,
      remaining: 0,
    })
  })
})
