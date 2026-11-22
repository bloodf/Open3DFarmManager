import { expect, test } from 'vitest'
import {
  issueLegacyToken,
  parseLegacyToken,
} from '../../apps/farm/server/storage/spool-library-credential.ts'
import { PostgresSpoolLibrary } from '../../apps/farm/server/storage/postgres-spool-library.ts'
import {
  SpoolFeedBus,
  spoolFeedBus,
} from '../../apps/farm/server/utils/spool-library/events.ts'
import type { SpoolLibraryStorage } from '../../apps/farm/server/utils/spool-library/scope.ts'
import {
  createSpoolFeedHooks,
  type FeedPeer,
  type SpoolFeedHooks,
} from '../../apps/farm/server/utils/spool-library/ws-feed.ts'

const FARM = '11111111-1111-4111-8111-111111111111'

function mockStorage(active: Map<string, string>): SpoolLibraryStorage {
  return {
    async withScope(authority, work) {
      if (authority.kind !== 'legacy-credential')
        return { ok: false, reason: 'unauthorized' }
      const parsed = parseLegacyToken(authority.token)
      const farmId = parsed ? active.get(parsed.credentialId) : undefined
      if (!parsed || !farmId) return { ok: false, reason: 'unauthorized' }
      return work({
        farmId,
        access: 'write',
        extraFields: {} as never,
        settings: {} as never,
        locations: {} as never,
        renameSpoolFieldValue: async () => ({ ok: false, reason: 'denied' }),
        vendors: {} as never,
        filaments: {} as never,
        spools: {} as never,
      })
    },
    async issueLegacyCredential() {
      return { ok: false, reason: 'denied' }
    },
    async listLegacyCredentials() {
      return { ok: false, reason: 'denied' }
    },
    async revokeLegacyCredential() {
      return { ok: false, reason: 'denied' }
    },
  }
}

async function openFeed(
  hooks: SpoolFeedHooks,
  token: string,
  path = '/api/v1/spool',
): Promise<{ peer: FeedPeer; closed: { code: number; reason: string }[] }> {
  const context: Record<string, unknown> = {}
  const closed: { code: number; reason: string }[] = []
  await hooks.upgrade({
    url: `http://localhost/spoolman/${token}${path}`,
    headers: new Headers({ host: 'localhost' }),
    context,
  })
  const peer: FeedPeer = {
    context,
    send() {},
    close(code = 1000, reason = '') {
      closed.push({ code, reason })
      hooks.close(peer)
    },
  }
  hooks.open(peer)
  return { peer, closed }
}

test('revoking a credential closes its open feeds and leaves sibling feeds open', async () => {
  const bus = new SpoolFeedBus()
  const a = issueLegacyToken()
  const b = issueLegacyToken()
  const active = new Map([
    [a.credentialId, FARM],
    [b.credentialId, FARM],
  ])
  const hooks = createSpoolFeedHooks({
    storage: async () => mockStorage(active),
    bus,
  })

  const feedA = await openFeed(hooks, a.token)
  const feedB = await openFeed(hooks, b.token)
  expect(feedA.closed).toEqual([])
  expect(feedB.closed).toEqual([])
  expect(bus.hasSubscribers(FARM)).toBe(true)

  active.delete(a.credentialId)
  bus.closeCredential(a.credentialId)

  expect(feedA.closed).toEqual([{ code: 4401, reason: 'Unauthorized' }])
  expect(feedB.closed).toEqual([])
  expect(bus.hasSubscribers(FARM)).toBe(true)

  bus.publish(FARM, [
    {
      pool: ['spool', '1'],
      text: '{"type":"updated","resource":"spool"}',
    },
  ])
  // Feed A must already be gone; feed B remains subscribed.
  expect(feedA.closed).toHaveLength(1)
  expect(feedB.closed).toEqual([])

  bus.closeCredential(b.credentialId)
  expect(feedB.closed).toEqual([{ code: 4401, reason: 'Unauthorized' }])
  expect(bus.hasSubscribers(FARM)).toBe(false)
})

test('process-wide bus closes feeds when a legacy credential is revoked', async () => {
  const issued = issueLegacyToken()
  const active = new Map([[issued.credentialId, FARM]])
  const hooks = createSpoolFeedHooks({
    storage: async () => mockStorage(active),
    bus: spoolFeedBus,
  })
  const feed = await openFeed(hooks, issued.token, '/api/v1/')
  expect(feed.closed).toEqual([])

  // Same call site postgres revoke uses after a successful tombstone write.
  spoolFeedBus.closeCredential(issued.credentialId)
  expect(feed.closed).toEqual([{ code: 4401, reason: 'Unauthorized' }])
})

test('Postgres storage revocation closes only the revoked process-wide feed', async () => {
  const issued = issueLegacyToken()
  const sibling = issueLegacyToken()
  const active = new Map([
    [issued.credentialId, FARM],
    [sibling.credentialId, FARM],
  ])
  const hooks = createSpoolFeedHooks({
    storage: async () => mockStorage(active),
    bus: spoolFeedBus,
  })
  const feed = await openFeed(hooks, issued.token, '/api/v1/')
  const siblingFeed = await openFeed(hooks, sibling.token, '/api/v1/')
  expect(feed.closed).toEqual([])
  expect(siblingFeed.closed).toEqual([])

  const sql = Object.assign(
    async (parts: TemplateStringsArray) => {
      const statement = parts.join('?')
      if (statement.includes('FROM farm.session_accounts'))
        return [{ id: 'account', sessionVersion: 0, disabled: false }]
      if (statement.includes('FROM farm.account_sessions'))
        return [
          {
            id: 'session',
            accountId: 'account',
            accountVersion: 0,
            createdAt: 0,
            lastSeenAt: 10,
            absoluteExpiresAt: 1000,
            revokedAt: null,
          },
        ]
      if (statement.includes('FROM farm.memberships'))
        return [{ role: 'owner', revoked_at: null }]
      if (statement.includes('UPDATE farm.spool_library_credentials'))
        return [{ id: issued.credentialId }]
      return []
    },
    { begin: async (work: (tx: unknown) => unknown) => work(sql) },
  )
  const storage = new PostgresSpoolLibrary(sql as never, () => 20)
  expect(
    await storage.revokeLegacyCredential({
      credentialId: issued.credentialId,
      farmId: FARM,
      sessionRecordId: 'session',
      policy: { idleTimeoutMs: 60_000 },
    }),
  ).toEqual({ ok: true, value: true })
  expect(feed.closed).toEqual([{ code: 4401, reason: 'Unauthorized' }])
  expect(siblingFeed.closed).toEqual([])
  spoolFeedBus.closeCredential(sibling.credentialId)
  expect(spoolFeedBus.hasSubscribers(FARM)).toBe(false)
})
