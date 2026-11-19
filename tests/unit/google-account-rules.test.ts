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
      const once = await beginOidcAuthorization(
        config,
        redirectUri,
        'openid email profile',
      )
      const response = await fetch(once.url, { redirect: 'manual' })
      const callback = new URL(response.headers.get('location') ?? '')
      await finishGoogleAuthorization(config, callback, once)
      await expect(
        finishGoogleAuthorization(config, callback, once),
      ).rejects.toMatchObject({ code: 'invalid' })
      mock.control.setScenario('unverified')
      await expect(round()).rejects.toMatchObject({ code: 'invalid' })
      mock.control.setScenario('wrong-audience')
      await expect(round()).rejects.toMatchObject({ code: 'audience' })
    } finally {
      await mock.close()
    }
  })
})

test('farm rules accept exact domains and reject invalid configuration', async () => {
  const { parseSignInRules } =
    await import('../../apps/farm/server/storage/sign-in-rules.ts')
  expect(
    parseSignInRules({
      mode: 'allowed-domains',
      allowedDomains: ['EXAMPLE.TEST', 'example.test'],
    }),
  ).toEqual({ mode: 'allowed-domains', allowedDomains: ['example.test'] })
  expect(
    parseSignInRules({
      mode: 'allowed-domains',
      allowedDomains: ['*.example.test'],
    }),
  ).toBeNull()
  expect(
    parseSignInRules({ mode: 'invite-only', allowedDomains: ['example.test'] }),
  ).toBeNull()
})

test('Google invitations require the bound email and never grant admin', async () => {
  const { googleInviteAllowed } =
    await import('../../apps/farm/server/utils/oidc-google-rules.ts')
  const invite = {
    verifiedEmail: 'member@example.test',
    boundEmail: 'member@example.test',
    role: 'viewer',
    mode: 'invite-only',
  }
  expect(googleInviteAllowed(invite)).toBe(true)
  expect(
    googleInviteAllowed({ ...invite, boundEmail: 'other@example.test' }),
  ).toBe(false)
  expect(googleInviteAllowed({ ...invite, boundEmail: null })).toBe(false)
  expect(googleInviteAllowed({ ...invite, role: 'admin' })).toBe(false)
  expect(googleInviteAllowed({ ...invite, role: 'owner' })).toBe(false)
  expect(googleInviteAllowed({ ...invite, mode: 'link-only' })).toBe(false)
})
