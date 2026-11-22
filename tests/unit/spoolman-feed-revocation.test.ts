import { expect, test } from 'vitest'
import {
  issueLegacyToken,
  parseLegacyToken,
} from '../../apps/farm/server/storage/spool-library-credential.ts'
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
