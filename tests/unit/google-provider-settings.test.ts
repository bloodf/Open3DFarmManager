import { expect, test } from 'vitest'
import { redact } from '../../packages/shared/src/log.ts'
import {
  GOOGLE_PROVIDER_PRESET,
  googlePublicView,
  googleSignInStatus,
  isInstallationAdmin,
  parseGoogleProviderWrite,
} from '../../apps/farm/server/utils/google-provider-preset.ts'
import {
  openClientSecret,
  sealClientSecret,
} from '../../apps/farm/server/utils/sign-in-provider-secret.ts'
import { MemorySignInProviderStore } from '../../apps/farm/server/storage/sign-in-provider.ts'

const MASTER = 'test-session-secret-32chars-minimum!!'
const ORIGIN = 'https://farm.example.test'

test('Google preset is accounts.google.com with PKCE and verified email', () => {
  expect(GOOGLE_PROVIDER_PRESET.issuer).toBe('https://accounts.google.com')
  expect(GOOGLE_PROVIDER_PRESET.scopes).toEqual(['openid', 'email', 'profile'])
  expect(GOOGLE_PROVIDER_PRESET.scope).toBe('openid email profile')
  expect(GOOGLE_PROVIDER_PRESET.pkce).toBe(true)
  expect(GOOGLE_PROVIDER_PRESET.emailVerifiedRequired).toBe(true)
  expect(GOOGLE_PROVIDER_PRESET.redirectPath).toBe('/api/auth/google/callback')
})

test('client secret seals at rest and never appears in public views or logs', () => {
  const sealed = sealClientSecret('google-client-secret-value', MASTER)
  expect(sealed.nonce).toHaveLength(12)
  expect(
    sealed.ciphertext.includes(Buffer.from('google-client-secret-value')),
  ).toBe(false)
  expect(openClientSecret(sealed, MASTER)).toBe('google-client-secret-value')
  const view = googlePublicView({
    origin: ORIGIN,
    enabled: true,
    clientId: 'client.apps.googleusercontent.com',
    hasClientSecret: true,
  })
  expect(view.redirectUri).toBe(
    'https://farm.example.test/api/auth/google/callback',
  )
  expect(view).not.toHaveProperty('clientSecret')
  expect(JSON.stringify(view)).not.toContain('google-client-secret-value')
  const logged = redact({
    clientSecret: 'google-client-secret-value',
    client_secret: 'google-client-secret-value',
    provider: view,
  }) as Record<string, unknown>
  expect(logged.clientSecret).toBe('[REDACTED]')
  expect(logged.client_secret).toBe('[REDACTED]')
})

test('admin write parsing keeps an omitted secret and rejects enabling without a client id', () => {
  expect(
    parseGoogleProviderWrite({
      enabled: true,
      clientId: 'id.apps.googleusercontent.com',
      clientSecret: 's3cret-value-here',
    }),
  ).toEqual({
    ok: true,
    enabled: true,
    clientId: 'id.apps.googleusercontent.com',
    clientSecret: 's3cret-value-here',
  })
  expect(
    parseGoogleProviderWrite({
      enabled: false,
      clientId: 'id.apps.googleusercontent.com',
    }),
  ).toEqual({
    ok: true,
    enabled: false,
    clientId: 'id.apps.googleusercontent.com',
  })
  expect(parseGoogleProviderWrite({ enabled: true, clientId: '' })).toEqual({
    ok: false,
  })
  expect(parseGoogleProviderWrite({ enabled: true })).toEqual({ ok: false })
})

test('only installation owners and admins may manage providers', () => {
  expect(isInstallationAdmin('owner')).toBe(true)
  expect(isInstallationAdmin('admin')).toBe(true)
  expect(isInstallationAdmin('operator')).toBe(false)
  expect(isInstallationAdmin('viewer')).toBe(false)
})

test('store encrypts secrets, hides the button when off, and keeps the sealed secret', async () => {
  const store = new MemorySignInProviderStore(MASTER)
  store.setActor('owner-1', 'owner')
  store.setActor('operator-1', 'operator')
  store.setActor('viewer-1', 'viewer')

  expect(await store.adminGet('operator-1', ORIGIN)).toBeNull()
  expect(await store.adminGet('viewer-1', ORIGIN)).toBeNull()
  expect(await store.publicStatus()).toEqual({
    enabled: false,
    reason: 'disabled',
  })
  expect(await store.runtimeCredentials()).toBeNull()

  const saved = await store.adminPut('owner-1', ORIGIN, {
    enabled: true,
    clientId: 'client.apps.googleusercontent.com',
    clientSecret: 'plain-secret-never-returned',
  })
  expect(saved).toMatchObject({
    enabled: true,
    clientId: 'client.apps.googleusercontent.com',
    hasClientSecret: true,
    redirectUri: ORIGIN + '/api/auth/google/callback',
    issuer: 'https://accounts.google.com',
    scopes: ['openid', 'email', 'profile'],
  })
  expect(JSON.stringify(saved)).not.toContain('plain-secret-never-returned')
  expect(await store.publicStatus()).toEqual({ enabled: true })
  const ready = await store.runtimeCredentials()
  expect(ready?.clientSecret).toBe('plain-secret-never-returned')
  expect(ready?.issuer).toBe('https://accounts.google.com')

  const sealedBefore = store.inspect().sealedSecret
  expect(sealedBefore).not.toBeNull()

  const off = await store.adminPut('owner-1', ORIGIN, {
    enabled: false,
    clientId: 'client.apps.googleusercontent.com',
  })
  expect(off?.enabled).toBe(false)
  expect(off?.hasClientSecret).toBe(true)
  expect(await store.publicStatus()).toEqual({
    enabled: false,
    reason: 'disabled',
  })
  expect(await store.runtimeCredentials()).toBeNull()
  expect(store.inspect().sealedSecret).toEqual(sealedBefore)

  expect(await store.publicStatus(true)).toEqual({
    enabled: false,
    reason: 'offline',
  })
  expect(
    googleSignInStatus({
      enabled: true,
      clientId: 'x',
      hasClientSecret: true,
      offline: true,
    }),
  ).toEqual({
    enabled: false,
    reason: 'offline',
  })
})

test('admin cannot enable Google without a stored secret', async () => {
  const store = new MemorySignInProviderStore(MASTER)
  store.setActor('admin-1', 'admin')
  expect(
    await store.adminPut('admin-1', ORIGIN, {
      enabled: true,
      clientId: 'client.apps.googleusercontent.com',
    }),
  ).toBeNull()
  expect(await store.publicStatus()).toEqual({
    enabled: false,
    reason: 'disabled',
  })
})
