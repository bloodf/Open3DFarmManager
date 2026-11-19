import { expect, test } from 'vitest'
import {
  accountIdentitiesView,
  canUnlinkGoogle,
  decideGoogleAccountLink,
} from '../../apps/farm/server/utils/identity-google.ts'
import { GOOGLE_PROVIDER_PRESET } from '../../apps/farm/server/utils/google-provider-preset.ts'
import {
  beginGoogleAuthorization,
  finishGoogleAuthorization,
} from '../../apps/farm/server/utils/oidc-google.ts'
import * as client from 'openid-client'
import {
  startOidcMock,
  withNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'

const redirectUri = 'http://127.0.0.1/api/auth/google/callback'

test('canUnlinkGoogle requires another sign-in method', () => {
  expect(
    canUnlinkGoogle({
      hasPassword: true,
      googleLinked: true,
      oidcLinked: false,
    }),
  ).toBe(true)
  expect(
    canUnlinkGoogle({
      hasPassword: false,
      googleLinked: true,
      oidcLinked: true,
    }),
  ).toBe(true)
  expect(
    canUnlinkGoogle({
      hasPassword: false,
      googleLinked: true,
      oidcLinked: false,
    }),
  ).toBe(false)
  expect(
    canUnlinkGoogle({
      hasPassword: true,
      googleLinked: false,
      oidcLinked: false,
    }),
  ).toBe(false)
})

test('accountIdentitiesView never exposes secrets', () => {
  const view = accountIdentitiesView({
    googleAvailable: true,
    googleLinked: true,
    canUnlinkGoogle: true,
  })
  expect(view).toEqual({
    google: { available: true, linked: true, canUnlink: true },
  })
  expect(JSON.stringify(view)).not.toMatch(/secret|subject/i)
})

test('decideGoogleAccountLink rejects foreign subjects and links cleanly', async () => {
  const links = new Map<string, string>()
  const directory = {
    async findLink(issuer: string, subject: string) {
      const accountId = links.get(`${issuer}\0${subject}`)
      return accountId ? { accountId } : null
    },
    async link(accountId: string, issuer: string, subject: string) {
      const key = `${issuer}\0${subject}`
      if (links.has(key)) return 'subject-taken' as const
      for (const [existingKey, owner] of links) {
        if (existingKey.startsWith(`${issuer}\0`) && owner === accountId)
          return 'issuer-linked' as const
      }
      links.set(key, accountId)
      return 'linked' as const
    },
  }
  const identity = Object.freeze({
    issuer: GOOGLE_PROVIDER_PRESET.issuer,
    subject: 'google-subject-1',
    email: 'member@example.test',
  })
  expect(
    await decideGoogleAccountLink(identity, 'account-a', directory),
  ).toEqual({ ok: true, code: 'linked' })
  expect(
    await decideGoogleAccountLink(identity, 'account-b', directory),
  ).toEqual({ ok: false, code: 'taken' })
  expect(
    await decideGoogleAccountLink(identity, 'account-a', directory),
  ).toEqual({ ok: true, code: 'already' })
  expect(
    await decideGoogleAccountLink(
      { ...identity, issuer: 'https://other.example.test' },
      'account-c',
      directory,
    ),
  ).toEqual({ ok: false, code: 'wrong-provider' })
})

test('Google link flow verifies email through the mock provider', async () => {
  await withNetworkGuard(async () => {
    const mock = await startOidcMock({ redirectUris: [redirectUri] })
    try {
      const secret = mock.clientSecret
      const config = await client.discovery(
        new URL(mock.issuer),
        mock.clientId,
        secret ?? undefined,
        secret ? client.ClientSecretPost(secret) : client.None(),
        { execute: [client.allowInsecureRequests] },
      )
      const begun = await beginGoogleAuthorization(config, redirectUri)
      const response = await fetch(begun.url, { redirect: 'manual' })
      const callback = new URL(response.headers.get('location') ?? '')
      const identity = await finishGoogleAuthorization(config, callback, begun)
      expect(identity.email).toBe('person@example.test')
      expect(identity.issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      await mock.close()
    }
  })
})
