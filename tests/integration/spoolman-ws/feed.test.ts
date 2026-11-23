import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { spoolFeedBus } from '../../../apps/farm/server/utils/spool-library/events.ts'
import { feedPool } from '../../../apps/farm/server/utils/spool-library/ws-feed.ts'
import { startHarness, type Harness } from './harness.ts'

const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/

describe('Spoolman websocket feeds', () => {
  let h: Harness
  let a: string
  let aRead: string
  let b: string
  before(async () => {
    h = await startHarness()
    a = h.token(0, 'write')
    aRead = h.token(0, 'read')
    b = h.token(1, 'write')
  })
  after(() => h.close())

  const seed = async (token: string, tag: string) => {
    const vendor = await h.call(token, 'POST', '/api/v1/vendor', {
      name: `${tag} Vendor`,
    })
    const filament = await h.call(token, 'POST', '/api/v1/filament', {
      name: `${tag} PETG`,
      vendor_id: vendor.body.id,
      material: 'PETG',
      density: 1.27,
      diameter: 1.75,
      weight: 1000,
    })
    const spool = await h.call(token, 'POST', '/api/v1/spool', {
      filament_id: filament.body.id,
      location: 'Shelf',
    })
    assert.deepEqual(
      [vendor.status, filament.status, spool.status],
      [200, 200, 200],
    )
    return { vendor: vendor.body, filament: filament.body, spool: spool.body }
  }

  it('maps every upstream feed path to its pool', () => {
    assert.deepEqual(feedPool('/api/v1/'), [])
    assert.deepEqual(feedPool('/api/v1'), [])
    assert.deepEqual(feedPool('/api/v1/vendor'), ['vendor'])
    assert.deepEqual(feedPool('/api/v1/filament/'), ['filament'])
    assert.deepEqual(feedPool('/api/v1/spool/007'), ['spool', '7'])
    assert.deepEqual(feedPool('/api/v1/setting/'), ['setting'])
    assert.deepEqual(feedPool('/api/v1/setting/currency'), [
      'setting',
      'currency',
    ])
    assert.deepEqual(feedPool('/api/v1/tag/scan'), ['tag_scan'])
    assert.deepEqual(feedPool('/api/v1/tag/scan/r1'), ['tag_scan', 'r1'])
    for (const bad of [
      '/api/v1/vendor/x',
      '/api/v1/vendor/99999999999',
      '/api/v1/vendor/1/2',
      '/api/v1/health',
      '/api/v1/location',
      '/other',
    ])
      assert.equal(feedPool(bad), undefined, bad)
  })

  it('root feed: added, updated, deleted with the HTTP payload', async () => {
    const root = await h.connect(a, '/api/v1/')
    const created = await h.call(a, 'POST', '/api/v1/vendor', {
      name: 'Root Vendor',
      comment: 'c',
    })
    const patched = await h.call(
      a,
      'PATCH',
      `/api/v1/vendor/${created.body.id}`,
      {
        comment: 'changed',
      },
    )
    const removed = await h.call(
      a,
      'DELETE',
      `/api/v1/vendor/${created.body.id}`,
    )
    assert.deepEqual(
      [created.status, patched.status, removed.status],
      [200, 200, 200],
    )
    const events = await root.next(3)
    assert.deepEqual(
      events.map((e) => [e.type, e.resource]),
      [
        ['added', 'vendor'],
        ['updated', 'vendor'],
        ['deleted', 'vendor'],
      ],
    )
    for (const e of events) {
      assert.deepEqual(Object.keys(e), ['type', 'resource', 'date', 'payload'])
      assert.match(e.date, DATE)
    }
    assert.deepEqual(events[0]!.payload, created.body)
    assert.deepEqual(events[1]!.payload, patched.body)
    assert.equal(events[1]!.payload.comment, 'changed')
    // The deleted event carries the record as it was.
    assert.deepEqual(events[2]!.payload, patched.body)
    await root.close()
  })

  it('entity and per-id feeds only hear their own records', async () => {
    const all = await h.connect(a, '/api/v1/')
    const vendors = await h.connect(a, '/api/v1/vendor')
    const spools = await h.connect(a, '/api/v1/spool/')
    const first = await seed(a, 'P1')
    const second = await seed(a, 'P2')
    const one = await h.connect(a, `/api/v1/spool/${first.spool.id}`)
    const oneFilament = await h.connect(
      a,
      `/api/v1/filament/${second.filament.id}`,
    )
    await h.call(a, 'PATCH', `/api/v1/spool/${first.spool.id}`, {
      comment: 'x',
    })
    await h.call(a, 'PATCH', `/api/v1/spool/${second.spool.id}`, {
      comment: 'y',
    })
    await h.call(a, 'PATCH', `/api/v1/filament/${second.filament.id}`, {
      comment: 'z',
    })

    const summary = (
      events: { type: string; resource: string; payload: any }[],
    ) => events.map((e) => `${e.type}:${e.resource}:${e.payload.id}`)
    await all.next(9)
    await h.settle()
    assert.deepEqual(summary(all.events), [
      `added:vendor:${first.vendor.id}`,
      `added:filament:${first.filament.id}`,
      `added:spool:${first.spool.id}`,
      `added:vendor:${second.vendor.id}`,
      `added:filament:${second.filament.id}`,
      `added:spool:${second.spool.id}`,
      `updated:spool:${first.spool.id}`,
      `updated:spool:${second.spool.id}`,
      `updated:filament:${second.filament.id}`,
    ])
    assert.deepEqual(summary(vendors.events), [
      `added:vendor:${first.vendor.id}`,
      `added:vendor:${second.vendor.id}`,
    ])
    assert.deepEqual(summary(spools.events), [
      `added:spool:${first.spool.id}`,
      `added:spool:${second.spool.id}`,
      `updated:spool:${first.spool.id}`,
      `updated:spool:${second.spool.id}`,
    ])
    assert.deepEqual(summary(one.events), [`updated:spool:${first.spool.id}`])
    assert.deepEqual(summary(oneFilament.events), [
      `updated:filament:${second.filament.id}`,
    ])
    // Payloads are the nested entities, shaped like the HTTP responses.
    const spool = all.events[6]!.payload
    assert.equal(spool.comment, 'x')
    assert.equal(spool.filament.id, first.filament.id)
    assert.equal(spool.filament.vendor.id, first.vendor.id)
    for (const feed of [all, vendors, spools, one, oneFilament])
      await feed.close()
  })

  it('spool use, archive and delete are all announced', async () => {
    const { spool } = await seed(a, 'U')
    const feed = await h.connect(a, `/api/v1/spool/${spool.id}`)
    const used = await h.call(a, 'PUT', `/api/v1/spool/${spool.id}/use`, {
      use_weight: 25,
    })
    assert.equal(used.status, 200)
    const archived = await h.call(a, 'PATCH', `/api/v1/spool/${spool.id}`, {
      archived: true,
    })
    const removed = await h.call(a, 'DELETE', `/api/v1/spool/${spool.id}`)
    assert.equal(removed.status, 200)
    const events = await feed.next(3)
    assert.deepEqual(
      events.map((e) => e.type),
      ['updated', 'updated', 'deleted'],
    )
    assert.deepEqual(events[0]!.payload, used.body)
    assert.equal(events[0]!.payload.used_weight, 25)
    assert.deepEqual(events[1]!.payload, archived.body)
    assert.equal(events[2]!.payload.id, spool.id)
    assert.equal(events[2]!.payload.archived, true)
    await feed.close()
  })

  it('deleting a vendor updates its filaments; a filament with spools is refused', async () => {
    const { vendor, filament, spool } = await seed(a, 'D')
    const feed = await h.connect(a, '/api/v1/')
    await h.call(a, 'DELETE', `/api/v1/vendor/${vendor.id}`)
    const afterVendor = await feed.next(2)
    assert.deepEqual(
      afterVendor.map((e) => [e.type, e.resource, e.payload.id]),
      [
        ['deleted', 'vendor', vendor.id],
        ['updated', 'filament', filament.id],
      ],
    )
    assert.equal(afterVendor[1]!.payload.vendor, undefined)
    const refused = await h.call(a, 'DELETE', `/api/v1/filament/${filament.id}`)
    assert.equal(refused.status, 403)
    await h.settle()
    assert.equal(feed.events.length, 2)
    await h.call(a, 'DELETE', `/api/v1/spool/${spool.id}`)
    const removed = await h.call(a, 'DELETE', `/api/v1/filament/${filament.id}`)
    assert.equal(removed.status, 200)
    const rest = await feed.next(4)
    assert.deepEqual(
      rest.slice(2).map((e) => [e.type, e.resource, e.payload.id]),
      [
        ['deleted', 'spool', spool.id],
        ['deleted', 'filament', filament.id],
      ],
    )
    assert.equal(rest[3]!.payload.name, 'D PETG')
    await feed.close()
  })

  it('location rename announces each changed spool', async () => {
    const { spool } = await seed(a, 'R')
    const feed = await h.connect(a, `/api/v1/spool/${spool.id}`)
    const renamed = await h.call(a, 'PATCH', '/api/v1/location/Shelf', {
      name: 'Rack 9',
    })
    assert.equal(renamed.status, 200)
    const [event] = await feed.next(1)
    assert.equal(event!.type, 'updated')
    assert.equal(event!.payload.location, 'Rack 9')
    await feed.close()
  })

  it('setting and extra-field changes reach the setting feeds', async () => {
    const root = await h.connect(a, '/api/v1/')
    const all = await h.connect(a, '/api/v1/setting/')
    const one = await h.connect(a, '/api/v1/setting/currency')
    const other = await h.connect(a, '/api/v1/setting/round_prices')
    const set = await h.call(a, 'POST', '/api/v1/setting/currency', '"USD"')
    assert.equal(set.status, 200)
    const field = await h.call(a, 'POST', '/api/v1/field/spool/slotws', {
      name: 'Slot',
      order: 1,
      field_type: 'integer',
      default_value: '0',
    })
    assert.equal(field.status, 200)
    const [event] = await one.next(1)
    assert.deepEqual(Object.keys(event!), [
      'type',
      'resource',
      'date',
      'payload',
    ])
    assert.equal(event!.type, 'updated')
    assert.equal(event!.resource, 'setting')
    assert.deepEqual(event!.payload, {
      key: 'currency',
      setting: { value: '"USD"', is_set: true, type: 'string' },
    })
    const events = await all.next(2)
    assert.equal(events[1]!.payload.key, 'extra_fields_spool')
    assert.equal(JSON.parse(events[1]!.payload.setting.value)[0].key, 'slotws')
    await root.next(2)
    await h.settle()
    assert.equal(one.events.length, 1)
    assert.equal(other.events.length, 0)
    for (const feed of [root, all, one, other]) await feed.close()
  })

  it("a client never receives another farm's events", async () => {
    const aRoot = await h.connect(a, '/api/v1/')
    const bRoot = await h.connect(b, '/api/v1/')
    const aSpools = await h.connect(aRead, '/api/v1/spool')
    const mine = await seed(a, 'FA')
    const theirs = await seed(b, 'FB')
    await h.call(b, 'PATCH', `/api/v1/vendor/${theirs.vendor.id}`, {
      comment: 'b',
    })
    await h.call(a, 'DELETE', `/api/v1/spool/${mine.spool.id}`)
    await aRoot.next(4)
    await bRoot.next(4)
    await h.settle()
    const names = (feed: { events: { payload: any }[] }) =>
      feed.events.map((e) => e.payload.name ?? e.payload.filament?.name)
    assert.ok(
      names(aRoot).every((n) => !String(n).startsWith('FB')),
      JSON.stringify(names(aRoot)),
    )
    assert.ok(names(bRoot).every((n) => !String(n).startsWith('FA')))
    assert.equal(aRoot.events.length, 4)
    assert.equal(bRoot.events.length, 4)
    // A read-only credential may listen (and only hears its own farm).
    assert.deepEqual(
      aSpools.events.map((e) => e.type),
      ['added', 'deleted'],
    )
    for (const feed of [aRoot, bRoot, aSpools]) await feed.close()
  })

  it('failed or refused writes emit nothing', async () => {
    const root = await h.connect(a, '/api/v1/')
    const invalid = await h.call(a, 'POST', '/api/v1/vendor', {
      comment: 'no name',
    })
    const missing = await h.call(a, 'PATCH', '/api/v1/vendor/999999', {
      name: 'n',
    })
    const denied = await h.call(aRead, 'POST', '/api/v1/vendor', { name: 'ro' })
    const badSetting = await h.call(a, 'POST', '/api/v1/setting/currency', '12')
    assert.deepEqual(
      [invalid.status, missing.status, denied.status, badSetting.status],
      [422, 404, 403, 415],
    )
    await h.settle()
    assert.deepEqual(root.events, [])
    await root.close()
  })

  it('refuses unknown credentials and paths at the handshake', async () => {
    assert.equal(await h.refused('not-a-token', '/api/v1/'), 401)
    assert.equal(await h.refused(a, '/api/v1/health'), 404)
    assert.equal(await h.refused(a, '/api/v1/vendor/abc'), 404)
    assert.equal(await h.refused(a.slice(0, -2) + 'xx', '/api/v1/'), 401)
  })

  it('closes a browser handshake from another origin with 4403', async () => {
    const foreign = await h.connect(a, '/api/v1/', {
      Origin: 'https://evil.example',
    })
    assert.deepEqual(await foreign.closed, {
      code: 4403,
      reason: 'Untrusted origin',
    })
    const same = await h.connect(a, '/api/v1/', {
      Origin: `http://${h.host}`,
    })
    await h.call(a, 'POST', '/api/v1/vendor', { name: 'Same Origin' })
    assert.equal((await same.next(1))[0]!.type, 'added')
    await same.close()
  })

  it('tag-scan feeds open but never hear entity changes', async () => {
    const scan = await h.connect(a, '/api/v1/tag/scan')
    const reader = await h.connect(a, '/api/v1/tag/scan/reader-1')
    await seed(a, 'T')
    await h.settle()
    assert.deepEqual([scan.events, reader.events], [[], []])
    await scan.close()
    await reader.close()
  })

  it('stops listening when the client disconnects', async () => {
    const farm = h.farms[0]!
    const base = spoolFeedBus.hasSubscribers(farm)
    const feed = await h.connect(a, '/api/v1/')
    assert.equal(spoolFeedBus.hasSubscribers(farm), true)
    await feed.close()
    await h.settle()
    assert.equal(spoolFeedBus.hasSubscribers(farm), base)
    assert.equal(base, false)
  })
})
