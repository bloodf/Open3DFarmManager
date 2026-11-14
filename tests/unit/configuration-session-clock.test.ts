import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { connectorKeyBinding } from '../../apps/farm/server/utils/connector-credentials.ts'
import { describe, it, expect, vi } from 'vitest'
import { type Sql } from 'postgres'
import { PostgresConfigurationStore } from '../../apps/farm/server/storage/postgres-configuration.ts'

const scope = {
  sessionRecordId: 'synthetic-session',
  farmId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  keyId: '33333333-3333-4333-8333-333333333333',
}
const config = {
  origin: 'https://farm.example',
  audience: 'farm',
  credentialIssuer: 'farm',
  credentialAudience: 'connector',
  idleTimeoutMs: 1800000,
}
async function authorityFixture() {
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const validated = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const connector = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  ).toString('base64url')
  const binding = await connectorKeyBinding(spki)
  const rows: Record<string, unknown[]> = {
    'SELECT id,session_version': [
      { id: 'synthetic-account', sessionVersion: 0, disabled: false },
    ],
    'SELECT id,account_id': [
      {
        id: scope.sessionRecordId,
        accountId: 'synthetic-account',
        accountVersion: 0,
        createdAt: 0,
        lastSeenAt: 0,
        absoluteExpiresAt: 100000,
        revokedAt: null,
      },
    ],
    'SELECT role,revoked_at': [{ role: 'owner', revoked_at: null }],
    'SELECT status,public_key': [
      {
        status: 'approved',
        public_key: validated.publicKey,
        thumbprint: validated.thumbprint,
        approved_at: 0,
        revoked_at: null,
      },
    ],
    'SELECT farm_id,status': [
      {
        farm_id: scope.farmId,
        status: 'approved',
        public_key_spki: spki,
        fingerprint: binding.fingerprint,
      },
    ],
    'SELECT jti,farm_id': [
      {
        jti: '55555555-5555-4555-8555-555555555555',
        farm_id: scope.farmId,
        fingerprint: binding.fingerprint,
        thumbprint: binding.thumbprint,
        issuer: 'farm',
        audience: 'connector',
        issued_at: 0,
        expires_at: 100,
      },
    ],
  }
  return rows
}

// Only the SQL boundary is simulated; all authority decisions use the exported store.
function database(rows: Record<string, unknown[]>, now: number) {
  const tx = async (parts: TemplateStringsArray) => {
    const query = parts.join('?')
    if (query.includes('observe_signalling_session_expiry')) return [{ now }]
    for (const [pattern, values] of Object.entries(rows)) {
      if (query.includes(pattern)) return values
    }
    return []
  }
  return {
    begin: async (_level: string, work: (tx: unknown) => Promise<void>) =>
      work(tx),
  } as unknown as Sql
}
describe('configuration session clock domains', () => {
  it.each([925, 1075])(
    'admits a host session with DB time %i',
    async (dbNow) => {
      const rows = await authorityFixture()
      Object.assign(rows['SELECT id,account_id']![0]!, {
        createdAt: 950,
        lastSeenAt: 1000,
      })
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
      try {
        const result = await new PostgresConfigurationStore(
          database(rows, dbNow),
          config,
        ).read(scope)
        expect(result?.authority.role).toBe('owner')
        expect(result?.observedAt).toBe(dbNow)
        expect(result?.authority.validUntil).toBe(100000)
      } finally {
        clock.mockRestore()
      }
    },
  )
})

it.each([
  ['future', { lastSeenAt: 1001 }, [1000, 1000]],
  ['rollback', { lastSeenAt: 900 }, [1000, 999]],
  ['absolute expiry', { absoluteExpiresAt: 1000 }, [1000, 1000]],
  ['idle expiry', { absoluteExpiresAt: 2000000 }, [1800000, 1800000]],
  ['revocation', { revokedAt: 500 }, [1000, 1000]],
  ['expiry during validation', { absoluteExpiresAt: 1001 }, [1000, 1001]],
] as const)(
  'rejects %s on the application clock',
  async (_name, changes, times) => {
    const rows = await authorityFixture()
    Object.assign(rows['SELECT id,account_id']![0]!, changes)
    let call = 0
    const store = new PostgresConfigurationStore(
      database(rows, 925),
      config,
      () => times[Math.min(call++, 1)]!,
    )
    expect(await store.read(scope)).toBeNull()
  },
)
