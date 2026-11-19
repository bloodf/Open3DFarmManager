import { expect, test } from 'vitest'
import * as client from 'openid-client'
import {
  startOidcMock,
  withNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'
import {
  beginOidcAuthorization,
  finishGoogleAuthorization,
} from '../../apps/farm/server/utils/oidc-login.ts'

const redirectUri = 'http://127.0.0.1/api/auth/oidc/callback'

test('Google requires a verified email after OIDC validation', async () => {
  await withNetworkGuard(async () => {
    const mock = await startOidcMock({ redirectUris: [redirectUri] })
    try {
      const config = await client.discovery(
        new URL(mock.issuer),
        mock.clientId,
        mock.clientSecret ?? undefined,
        mock.clientSecret
          ? client.ClientSecretPost(mock.clientSecret)
          : client.None(),
        { execute: [client.allowInsecureRequests] },
      )
      async function round(mismatch?: 'state' | 'nonce') {
        const transaction = await beginOidcAuthorization(
          config,
          redirectUri,
          'openid email profile',
        )
        const response = await fetch(transaction.url, { redirect: 'manual' })
        const callback = new URL(response.headers.get('location') ?? '')
        return finishGoogleAuthorization(config, callback, {
          ...transaction,
          ...(mismatch ? { [mismatch]: 'replayed-value' } : {}),
        })
      }
      expect((await round()).email).toBe('person@example.test')
      await expect(round('state')).rejects.toMatchObject({ code: 'state' })
      await expect(round('nonce')).rejects.toMatchObject({ code: 'nonce' })
      mock.control.setScenario('unverified')
      await expect(round()).rejects.toMatchObject({ code: 'invalid' })
      mock.control.setScenario('wrong-audience')
      await expect(round()).rejects.toMatchObject({ code: 'audience' })
    } finally {
      await mock.close()
    }
  })
})
