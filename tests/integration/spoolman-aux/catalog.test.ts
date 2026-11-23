import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { seedInventory, startHarness, type Harness } from './harness.ts'

describe('lists, export, search and groups', () => {
  let h: Harness
  let a: string
  let aRead: string
  let b: string
  let ids: Record<string, { vendor: any; filament: any; spool: any }> = {}
  before(async () => {
    h = await startHarness()
    a = h.token(0, 'write')
    aRead = h.token(0, 'read')
    b = h.token(1, 'write')
    await h.call(a, 'POST', '/api/v1/field/spool/shelf', {
      name: 'Shelf',
      field_type: 'text',
    })
    ids['red'] = await seedInventory(h, a, 'Red', {
      location: 'Dry box',
      lot_nr: 'LOT-1',
      comment: 'weekend print stock',
      used_weight: 250,
      extra: { shelf: '"Top"' },
    })
    ids['red2'] = await seedInventory(h, a, 'Crimson', {
      location: 'Dry box',
      lot_nr: 'LOT-2',
    })
    ids['arch'] = await seedInventory(h, a, 'Archived', {
      location: 'Old rack',
      archived: true,
    })
    await seedInventory(h, b, 'Foreign', {
      location: 'Foreign shelf',
      lot_nr: 'LOT-B',
    })
  })
  after(() => h.close())

  it('lists distinct materials, article numbers and lot numbers of this farm', async () => {
    assert.deepEqual((await h.call(aRead, 'GET', '/api/v1/material')).body, [
      'PETG',
    ])
    const articles = await h.call(aRead, 'GET', '/api/v1/article-number')
    assert.deepEqual(articles.body, ['ART-Archived', 'ART-Crimson', 'ART-Red'])
    assert.deepEqual((await h.call(aRead, 'GET', '/api/v1/lot-number')).body, [
      'LOT-1',
      'LOT-2',
    ])
    assert.deepEqual((await h.call(b, 'GET', '/api/v1/lot-number')).body, [
      'LOT-B',
    ])
    assert.deepEqual(
      (await h.call(aRead, 'GET', '/api/v1/tag/reader')).body,
      [],
    )
    assert.equal((await h.call(a, 'POST', '/api/v1/material')).status, 405)
  })

  it('exports vendors, filaments and spools as JSON and CSV', async () => {
    const vendors = await h.call(
      aRead,
      'GET',
      '/api/v1/export/vendors?fmt=json',
    )
    assert.equal(vendors.status, 200)
    assert.deepEqual(
      vendors.body.map((v: any) => v.name),
      ['Red Vendor', 'Crimson Vendor', 'Archived Vendor'],
    )
    const filaments = await h.call(
      aRead,
      'GET',
      '/api/v1/export/filaments?fmt=json',
    )
    assert.equal(filaments.body.length, 3)
    assert.equal(filaments.body[0].vendor.name, 'Red Vendor')

    const spools = await h.call(aRead, 'GET', '/api/v1/export/spools?fmt=json')
    assert.deepEqual(
      spools.body.map((s: any) => s.id),
      [ids['red']!.spool.id, ids['red2']!.spool.id],
      'archived excluded by default',
    )
    const all = await h.call(
      aRead,
      'GET',
      '/api/v1/export/spools?fmt=json&allow_archived=true',
    )
    assert.equal(all.body.length, 3)
    assert.equal(all.body[0].filament.vendor.name, 'Red Vendor')

    const csv = await h.call(aRead, 'GET', '/api/v1/export/spools?fmt=csv')
    assert.equal(csv.status, 200)
    assert.match(csv.headers['content-type'] ?? '', /^text\/csv/)
    const lines = csv.text.trim().split('\r\n')
    assert.equal(lines.length, 3, 'header + two spools')
    const header = lines[0]!.split(',')
    for (const column of [
      'id',
      'filament.name',
      'filament.vendor.name',
      'extra.shelf',
      'location',
    ])
      assert.ok(header.includes(column), column)
    assert.ok(csv.text.includes('Red PETG'))
    assert.equal(csv.text.includes('Foreign'), false)
    const vendorCsv = await h.call(
      aRead,
      'GET',
      '/api/v1/export/vendors?fmt=csv',
    )
    assert.ok(vendorCsv.text.startsWith('id,registered,name,'))

    const missing = await h.call(aRead, 'GET', '/api/v1/export/vendors')
    assert.equal(missing.status, 422)
    assert.deepEqual(missing.body.detail[0], {
      type: 'missing',
      loc: ['query', 'fmt'],
      msg: 'Field required',
      input: null,
    })
    const bad = await h.call(aRead, 'GET', '/api/v1/export/vendors?fmt=xml')
    assert.equal(bad.body.detail[0].type, 'enum')
    assert.equal(bad.body.detail[0].msg, "Input should be 'csv' or 'json'")
    const flag = await h.call(
      aRead,
      'GET',
      '/api/v1/export/spools?fmt=json&allow_archived=maybe',
    )
    assert.equal(flag.status, 422)
    assert.equal(
      (await h.call(aRead, 'POST', '/api/v1/export/vendors?fmt=json')).status,
      405,
    )
  })

  it('searches every term across spools, filaments and vendors', async () => {
    const r = await h.call(aRead, 'GET', '/api/v1/search?q=red')
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body).sort(), [
      'filaments',
      'is_color_query',
      'spools',
      'vendors',
    ])
    assert.equal(r.body.is_color_query, false)
    assert.deepEqual(
      r.body.vendors.map((v: any) => [v.vendor.name, v.match_field]),
      [['Red Vendor', 'name']],
    )
    assert.deepEqual(
      r.body.filaments.map((f: any) => [f.filament.name, f.match_field]),
      [['Red PETG', 'name']],
    )
    assert.equal(
      r.body.spools.length,
      0,
      'spool text fields do not mention red',
    )

    const spool = await h.call(aRead, 'GET', '/api/v1/search?q=weekend%20stock')
    assert.deepEqual(
      spool.body.spools.map((s: any) => [s.spool.id, s.match_field]),
      [[ids['red']!.spool.id, 'comment']],
    )
    const viaExtra = await h.call(aRead, 'GET', '/api/v1/search?q=top')
    assert.deepEqual(
      viaExtra.body.spools.map((s: any) => s.match_field),
      ['extra.shelf'],
    )
    const viaVendor = await h.call(
      aRead,
      'GET',
      '/api/v1/search?q=crimson%20petg',
    )
    assert.deepEqual(
      viaVendor.body.filaments.map((f: any) => f.filament.name),
      ['Crimson PETG'],
    )
    const byId = await h.call(
      aRead,
      'GET',
      `/api/v1/search?q=${ids['red2']!.spool.id}`,
    )
    assert.deepEqual(
      byId.body.spools.map((s: any) => [s.spool.id, s.match_field]),
      [[ids['red2']!.spool.id, 'id']],
    )
    assert.equal(
      (await h.call(aRead, 'GET', '/api/v1/search?q=foreign')).body.vendors
        .length,
      0,
    )
    assert.equal(
      (await h.call(aRead, 'GET', '/api/v1/search?q=nothing-matches-this')).body
        .spools.length,
      0,
    )
  })

  it('honours allow_archived, limit, spools_per_filament and colour queries', async () => {
    const archived = ids['arch']!.spool
    const hidden = await h.call(aRead, 'GET', '/api/v1/search?q=old%20rack')
    assert.equal(hidden.body.spools.length, 0)
    const shown = await h.call(
      aRead,
      'GET',
      '/api/v1/search?q=old%20rack&allow_archived=true',
    )
    assert.deepEqual(
      shown.body.spools.map((s: any) => s.spool.id),
      [archived.id],
    )

    const limited = await h.call(aRead, 'GET', '/api/v1/search?q=petg&limit=1')
    assert.equal(limited.body.filaments.length, 1)
    assert.equal(limited.body.filaments[0].spools, undefined)
    const withSpools = await h.call(
      aRead,
      'GET',
      '/api/v1/search?q=red%20petg&spools_per_filament=2',
    )
    const hit = withSpools.body.filaments[0]
    assert.equal(hit.spool_count, 1)
    assert.deepEqual(hit.spools, [
      {
        id: ids['red']!.spool.id,
        archived: false,
        location: 'Dry box',
        remaining_weight: 750,
      },
    ])

    const color = await h.call(
      aRead,
      'GET',
      '/api/v1/search?q=%23ff0000&color_similarity_threshold=5',
    )
    assert.equal(color.body.is_color_query, true)
    assert.equal(color.body.filaments.length, 3)
    assert.ok(color.body.filaments.every((f: any) => f.match_field === 'color'))
    const none = await h.call(
      aRead,
      'GET',
      '/api/v1/search?q=%230000ff&color_similarity_threshold=5',
    )
    assert.equal(none.body.filaments.length, 0)

    const missing = await h.call(aRead, 'GET', '/api/v1/search')
    assert.equal(missing.status, 422)
    assert.deepEqual(missing.body.detail[0].loc, ['query', 'q'])
    for (const query of [
      'q=a&limit=0',
      'q=a&limit=101',
      'q=a&spools_per_filament=11',
      'q=a&color_similarity_threshold=101',
      'q=a&limit=x',
      'q=',
    ]) {
      assert.equal(
        (await h.call(aRead, 'GET', `/api/v1/search?${query}`)).status,
        422,
        query,
      )
    }
  })

  it('groups spools by every axis with aggregates and totals in headers', async () => {
    const byFilament = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=filament',
    )
    assert.equal(byFilament.status, 200)
    assert.equal(byFilament.headers['x-total-count'], '2')
    assert.equal(byFilament.headers['x-total-spools'], '2')
    assert.equal(byFilament.headers['x-total-remaining-weight'], '1750')
    const first = byFilament.body.find(
      (g: any) => g.filament.name === 'Red PETG',
    )
    assert.equal(first.group_by, 'filament')
    assert.equal(first.key, String(ids['red']!.filament.id))
    assert.equal(first.spool_count, 1)
    assert.equal(first.in_use_count, 1)
    assert.equal(first.total_remaining_weight, 750)
    assert.equal(first.spools, undefined)

    const withPreview = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=filament&preview=true&sort=group.total_remaining:asc',
    )
    assert.deepEqual(withPreview.body[0].spools, [
      { id: ids['red']!.spool.id, remaining_weight: 750, initial_weight: 1000 },
    ])

    const byLocation = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=location',
    )
    assert.deepEqual(
      byLocation.body.map((g: any) => [g.key, g.spool_count]),
      [['Dry box', 2]],
    )
    const archived = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=location&allow_archived=true',
    )
    assert.deepEqual(
      archived.body.map((g: any) => g.key),
      ['Dry box', 'Old rack'],
    )
    const byMaterial = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=material',
    )
    assert.deepEqual(
      byMaterial.body.map((g: any) => [g.key, g.spool_count]),
      [['PETG', 2]],
    )
    const byExtra = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=extra.shelf',
    )
    assert.deepEqual(
      byExtra.body
        .map((g: any) => g.key)
        .sort((x: any, y: any) => String(x).localeCompare(String(y))),
      [null, 'Top'],
    )
    const byVendor = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=vendor&preview=true',
    )
    assert.equal(byVendor.body.length, 2)
    assert.equal(byVendor.body[0].vendor.name, 'Crimson Vendor')
    assert.equal(byVendor.body[0].filament_count, 1)
    assert.equal(byVendor.body[0].filaments[0].color_hex, 'FF0000')

    const empty = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=vendor&include_empty=true&allow_archived=true',
    )
    assert.equal(empty.body.length, 3)
    const filtered = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=filament&filament.material=petg&limit=1&offset=1',
    )
    assert.equal(filtered.body.length, 1)
    assert.equal(filtered.headers['x-total-count'], '2')
    const lot = await h.call(
      aRead,
      'GET',
      '/api/v1/spool/group?group_by=location&lot_nr=LOT-1',
    )
    assert.deepEqual(
      lot.body.map((g: any) => g.spool_count),
      [1],
    )
    // Other farm's data never appears.
    const other = await h.call(
      b,
      'GET',
      '/api/v1/spool/group?group_by=location',
    )
    assert.deepEqual(
      other.body.map((g: any) => g.key),
      ['Foreign shelf'],
    )
  })

  it('rejects invalid group queries', async () => {
    const missing = await h.call(aRead, 'GET', '/api/v1/spool/group')
    assert.equal(missing.status, 422)
    assert.deepEqual(missing.body.detail[0].loc, ['query', 'group_by'])
    for (const query of [
      'group_by=colour',
      'group_by=extra.nope',
      'group_by=location&include_empty=true&location=x',
      'group_by=material&first_used=garbage',
    ]) {
      const r = await h.call(aRead, 'GET', `/api/v1/spool/group?${query}`)
      assert.equal(r.status, 400, query)
      assert.deepEqual(Object.keys(r.body), ['message'])
    }
    assert.equal(
      (
        await h.call(
          aRead,
          'GET',
          '/api/v1/spool/group?group_by=material&filament.id=a',
        )
      ).status,
      422,
    )
    assert.equal(
      (
        await h.call(
          aRead,
          'GET',
          '/api/v1/spool/group?group_by=material&limit=x',
        )
      ).status,
      422,
    )
    assert.equal(
      (await h.call(a, 'POST', '/api/v1/spool/group?group_by=material')).status,
      405,
    )
  })
})
