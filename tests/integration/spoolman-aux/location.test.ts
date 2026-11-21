import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { splitLegacyPath } from '../../../apps/farm/server/utils/spool-library/legacy-path.ts'
import { seedInventory, startHarness, type Harness } from './harness.ts'

describe('locations and spool field renames', () => {
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

  it('lists distinct locations of this farm only, sorted', async () => {
    assert.deepEqual((await h.call(aRead, 'GET', '/api/v1/location')).body, [])
    await seedInventory(h, a, 'L1', { location: 'Storage Shelf A' })
    await seedInventory(h, a, 'L2', { location: 'Printer 1' })
    await seedInventory(h, a, 'L3', { location: 'Printer 1' })
    await seedInventory(h, a, 'L4')
    await seedInventory(h, b, 'B1', { location: 'Other farm shelf' })
    const r = await h.call(aRead, 'GET', '/api/v1/location')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, ['Printer 1', 'Storage Shelf A'])
    assert.deepEqual((await h.call(b, 'GET', '/api/v1/location')).body, [
      'Other farm shelf',
    ])
  })

  it('renames a location (percent-encoded in the path) and merges onto a used one', async () => {
    const r = await h.call(a, 'PATCH', '/api/v1/location/Storage%20Shelf%20A', {
      name: 'Shelf B',
    })
    assert.equal(r.status, 200)
    assert.equal(r.text, '"Shelf B"')
    assert.equal(r.headers['content-type'], 'application/json')
    assert.deepEqual((await h.call(a, 'GET', '/api/v1/location')).body, [
      'Printer 1',
      'Shelf B',
    ])
    // Rename onto a value in use merges the two.
    await h.call(a, 'PATCH', '/api/v1/location/Shelf%20B', {
      name: 'Printer 1',
    })
    assert.deepEqual((await h.call(a, 'GET', '/api/v1/location')).body, [
      'Printer 1',
    ])
    const spools = await h.call(
      a,
      'GET',
      '/api/v1/spool?location=%22Printer%201%22',
    )
    assert.equal(spools.body.length, 3)
    // Renaming a location nobody holds is a no-op that still answers the name.
    const none = await h.call(a, 'PATCH', '/api/v1/location/Nowhere', {
      name: 'Somewhere',
    })
    assert.equal(none.status, 200)
    assert.equal(none.text, '"Somewhere"')
  })

  it('never touches another farm even with the same location name', async () => {
    await seedInventory(h, b, 'B2', { location: 'Printer 1' })
    await h.call(a, 'PATCH', '/api/v1/location/Printer%201', {
      name: 'Dry box',
    })
    assert.deepEqual((await h.call(b, 'GET', '/api/v1/location')).body.sort(), [
      'Other farm shelf',
      'Printer 1',
    ])
    assert.deepEqual((await h.call(a, 'GET', '/api/v1/location')).body, [
      'Dry box',
    ])
  })

  it('validates the body, the method and the credential', async () => {
    const empty = await h.call(a, 'PATCH', '/api/v1/location/Dry%20box', {
      name: '',
    })
    assert.equal(empty.status, 422)
    assert.equal(empty.body.detail[0].type, 'string_too_short')
    assert.deepEqual(empty.body.detail[0].loc, ['body', 'name'])
    const missing = await h.call(a, 'PATCH', '/api/v1/location/Dry%20box', {})
    assert.equal(missing.body.detail[0].type, 'missing')
    assert.equal(
      (await h.call(a, 'PATCH', '/api/v1/location/Dry%20box')).status,
      422,
    )
    assert.equal(
      (
        await h.call(aRead, 'PATCH', '/api/v1/location/Dry%20box', {
          name: 'x',
        })
      ).status,
      403,
    )
    assert.equal((await h.call(a, 'POST', '/api/v1/location')).status, 405)
    assert.equal(
      (await h.call(a, 'GET', '/api/v1/location/Dry%20box')).status,
      405,
    )
    // Encoded slashes and malformed escapes never reach a handler.
    assert.equal(
      (await h.call(a, 'PATCH', '/api/v1/location/a%2Fb', { name: 'x' }))
        .status,
      401,
    )
    assert.equal(
      (await h.call(a, 'PATCH', '/api/v1/location/%E0%A4%A', { name: 'x' }))
        .status,
      401,
    )
  })

  it('decodes the API path once and refuses unsafe escapes, never the credential', () => {
    const token = h.token(0, 'read')
    const split = (rest: string) => splitLegacyPath(`/spoolman/${token}${rest}`)
    assert.equal(split('/api/v1/location/Shelf%20A').ok, true)
    assert.equal(
      (split('/api/v1/location/Shelf%20A') as { apiPath: string }).apiPath,
      '/api/v1/location/Shelf A',
    )
    assert.equal(
      (split('/api/v1/location/100%25') as { apiPath: string }).apiPath,
      '/api/v1/location/100%',
    )
    for (const bad of [
      '%2e%2e',
      '%2E',
      '%2f',
      '%2F',
      '%5c',
      '%5C',
      '%00',
      '%E0%A4%A',
      '%zz',
      '/../x',
      '//x',
    ])
      assert.equal(split(`/api/v1/location/${bad}`).ok, false, bad)
    assert.equal(
      splitLegacyPath(
        `/spoolman/${token.replace('sl1.', 'sl%31.')}/api/v1/info`,
      ).ok,
      false,
    )
  })

  it('renames one value of a spool field wherever it occurs, archived spools included', async () => {
    await h.call(a, 'POST', '/api/v1/field/spool/shelf', {
      name: 'Shelf',
      field_type: 'text',
    })
    await h.call(a, 'POST', '/api/v1/field/spool/tags', {
      name: 'Tags',
      field_type: 'choice',
      choices: ['x', 'y'],
      multi_choice: true,
    })
    const one = await seedInventory(h, a, 'F1', {
      location: 'Rack 1',
      extra: { shelf: '"S1"' },
    })
    const two = await seedInventory(h, a, 'F2', {
      location: 'Rack 1',
      archived: true,
      extra: { shelf: '"S1"' },
    })
    const three = await seedInventory(h, a, 'F3', { extra: { shelf: '"S9"' } })
    const farmB = await seedInventory(h, b, 'FB', { location: 'Rack 1' })

    const loc = await h.call(a, 'PATCH', '/api/v1/spool/field/location', {
      value: 'Rack 1',
      new_value: 'Rack 2',
    })
    assert.equal(loc.status, 200)
    assert.deepEqual(loc.body, { spools_updated: 2 })
    assert.equal(
      (await h.call(a, 'GET', `/api/v1/spool/${two.spool.id}`)).body.location,
      'Rack 2',
    )
    assert.equal(
      (await h.call(b, 'GET', `/api/v1/spool/${farmB.spool.id}`)).body.location,
      'Rack 1',
    )

    const extra = await h.call(a, 'PATCH', '/api/v1/spool/field/extra.shelf', {
      value: 'S1',
      new_value: 'S2',
    })
    assert.deepEqual(extra.body, { spools_updated: 2 })
    assert.deepEqual(
      (await h.call(a, 'GET', `/api/v1/spool/${one.spool.id}`)).body.extra,
      { shelf: '"S2"' },
    )
    assert.deepEqual(
      (await h.call(a, 'GET', `/api/v1/spool/${three.spool.id}`)).body.extra,
      { shelf: '"S9"' },
    )

    for (const field of [
      'material',
      'extra.unknown',
      'extra.tags',
      'filament.name',
    ]) {
      const bad = await h.call(a, 'PATCH', `/api/v1/spool/field/${field}`, {
        value: 'a',
        new_value: 'b',
      })
      assert.equal(bad.status, 400, field)
      assert.deepEqual(Object.keys(bad.body), ['message'])
    }
    const invalid = await h.call(a, 'PATCH', '/api/v1/spool/field/location', {
      value: '',
      new_value: 'x',
    })
    assert.equal(invalid.status, 422)
    assert.deepEqual(invalid.body.detail[0].loc, ['body', 'value'])
    assert.equal(
      (
        await h.call(aRead, 'PATCH', '/api/v1/spool/field/location', {
          value: 'a',
          new_value: 'b',
        })
      ).status,
      403,
    )
    assert.equal(
      (await h.call(a, 'GET', '/api/v1/spool/field/location')).status,
      405,
    )
  })
})
