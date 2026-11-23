import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { seedInventory, startHarness, type Harness } from './harness.ts'

/** The Spoolman client double-encodes: a JSON string holding the JSON value. */
const encode = (value: unknown) => ({
  raw: JSON.stringify(JSON.stringify(value)),
})

describe('settings', () => {
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

  it('lists every registered setting with its default when unset', async () => {
    const r = await h.call(aRead, 'GET', '/api/v1/setting/')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.currency, {
      value: '"EUR"',
      is_set: false,
      type: 'string',
    })
    assert.deepEqual(r.body.round_prices, {
      value: 'false',
      is_set: false,
      type: 'boolean',
    })
    assert.deepEqual(r.body.base_url, {
      value: '""',
      is_set: false,
      type: 'string',
    })
    assert.equal(r.body.print_presets.type, 'array')
    assert.equal(r.body.locations_spoolorders.type, 'object')
    for (const view of Object.values<any>(r.body))
      assert.deepEqual(Object.keys(view).sort(), ['is_set', 'type', 'value'])
  })

  it('sets, reads back and resets one setting', async () => {
    const set = await h.call(
      a,
      'POST',
      '/api/v1/setting/currency',
      undefined,
      encode('USD'),
    )
    assert.equal(set.status, 200)
    assert.deepEqual(set.body, { value: '"USD"', is_set: true, type: 'string' })
    const get = await h.call(aRead, 'GET', '/api/v1/setting/currency')
    assert.deepEqual(get.body, set.body)
    const bool = await h.call(
      a,
      'POST',
      '/api/v1/setting/round_prices',
      undefined,
      encode(true),
    )
    assert.deepEqual(bool.body, {
      value: 'true',
      is_set: true,
      type: 'boolean',
    })
    const obj = await h.call(
      a,
      'POST',
      '/api/v1/setting/locations_spoolorders',
      undefined,
      encode({ 'Shelf A': [1, 2] }),
    )
    assert.equal(obj.body.value, '{"Shelf A":[1,2]}')

    // Another farm never sees it.
    assert.equal(
      (await h.call(b, 'GET', '/api/v1/setting/currency')).body.is_set,
      false,
    )

    // Empty body and the text `null` both reset to the default.
    const reset = await h.call(a, 'POST', '/api/v1/setting/currency')
    assert.deepEqual(reset.body, {
      value: '"EUR"',
      is_set: false,
      type: 'string',
    })
    await h.call(
      a,
      'POST',
      '/api/v1/setting/currency',
      undefined,
      encode('SEK'),
    )
    const nulled = await h.call(
      a,
      'POST',
      '/api/v1/setting/currency',
      undefined,
      { raw: 'null' },
    )
    assert.equal(nulled.body.is_set, false)
    const nullText = await h.call(
      a,
      'POST',
      '/api/v1/setting/currency',
      undefined,
      { raw: '"null"' },
    )
    assert.equal(nullText.body.is_set, false)
  })

  it('rejects unknown keys, wrong types, bad bodies and read-only credentials', async () => {
    const unknown = await h.call(aRead, 'GET', '/api/v1/setting/does_not_exist')
    assert.equal(unknown.status, 404)
    assert.equal(typeof unknown.body.message, 'string')
    assert.deepEqual(Object.keys(unknown.body), ['message'])
    assert.equal(
      (await h.call(a, 'POST', '/api/v1/setting/nope', undefined, encode('x')))
        .status,
      404,
    )
    const wrong = await h.call(
      a,
      'POST',
      '/api/v1/setting/round_prices',
      undefined,
      encode('yes'),
    )
    assert.equal(wrong.status, 415)
    assert.deepEqual(Object.keys(wrong.body), ['message'])
    const notJson = await h.call(
      a,
      'POST',
      '/api/v1/setting/currency',
      undefined,
      { raw: JSON.stringify('not json{') },
    )
    assert.equal(notJson.status, 415)
    const notString = await h.call(a, 'POST', '/api/v1/setting/currency', 123)
    assert.equal(notString.status, 422)
    assert.equal(notString.body.detail[0].type, 'string_type')
    assert.deepEqual(notString.body.detail[0].loc, ['body'])
    const invalid = await h.call(
      a,
      'POST',
      '/api/v1/setting/currency',
      undefined,
      { raw: '{oops', contentType: 'application/json' },
    )
    assert.equal(invalid.status, 422)
    assert.equal(invalid.body.detail[0].type, 'json_invalid')
    const denied = await h.call(
      aRead,
      'POST',
      '/api/v1/setting/currency',
      undefined,
      encode('NOK'),
    )
    assert.equal(denied.status, 403)
    assert.deepEqual(denied.body, { message: 'Forbidden' })
    assert.equal(
      (await h.call(a, 'DELETE', '/api/v1/setting/currency')).status,
      405,
    )
    assert.equal((await h.call(a, 'POST', '/api/v1/setting/')).status, 405)
  })
})

describe('extra fields', () => {
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

  it('adds, updates, lists and deletes definitions, answering with the full list', async () => {
    assert.deepEqual(
      (await h.call(aRead, 'GET', '/api/v1/field/spool')).body,
      [],
    )
    const added = await h.call(a, 'POST', '/api/v1/field/spool/slot', {
      name: 'Slot',
      order: 2,
      unit: '#',
      field_type: 'integer',
      default_value: '0',
    })
    assert.equal(added.status, 200)
    assert.deepEqual(added.body, [
      {
        key: 'slot',
        entity_type: 'spool',
        name: 'Slot',
        order: 2,
        unit: '#',
        field_type: 'integer',
        default_value: '0',
        choices: null,
        multi_choice: false,
      },
    ])
    const choice = await h.call(a, 'POST', '/api/v1/field/spool/finish', {
      name: 'Finish',
      order: 1,
      field_type: 'choice',
      choices: ['matte', 'glossy'],
      multi_choice: true,
      default_value: '["matte"]',
    })
    assert.deepEqual(
      choice.body.map((f: { key: string }) => f.key),
      ['finish', 'slot'],
    )
    assert.equal(choice.body[0].multi_choice, true)
    assert.deepEqual(choice.body[0].choices, ['matte', 'glossy'])

    const renamed = await h.call(a, 'POST', '/api/v1/field/spool/slot', {
      name: 'AMS slot',
      field_type: 'integer',
    })
    assert.equal(
      renamed.body.find((f: { key: string }) => f.key === 'slot').name,
      'AMS slot',
    )
    assert.equal(
      renamed.body.find((f: { key: string }) => f.key === 'slot').order,
      0,
    )

    // Other entity types and other farms are separate registries.
    assert.deepEqual(
      (await h.call(a, 'GET', '/api/v1/field/filament')).body,
      [],
    )
    assert.deepEqual((await h.call(b, 'GET', '/api/v1/field/spool')).body, [])
  })

  it('definitions drive extra-field validation on records and delete strips values', async () => {
    const seeded = await seedInventory(h, a, 'Fld')
    const ok = await h.call(a, 'PATCH', `/api/v1/spool/${seeded.spool.id}`, {
      extra: { slot: '4' },
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.extra, { slot: '4' })
    const bad = await h.call(a, 'PATCH', `/api/v1/spool/${seeded.spool.id}`, {
      extra: { slot: '"four"' },
    })
    assert.equal(bad.status, 400)

    const values = await h.call(aRead, 'GET', '/api/v1/field/spool/slot/values')
    assert.equal(values.status, 200)
    assert.deepEqual(values.body, ['4'])

    const removed = await h.call(a, 'DELETE', '/api/v1/field/spool/slot')
    assert.equal(removed.status, 200)
    assert.deepEqual(
      removed.body.map((f: { key: string }) => f.key),
      ['finish'],
    )
    const spool = await h.call(a, 'GET', `/api/v1/spool/${seeded.spool.id}`)
    assert.deepEqual(spool.body.extra, {})
    const again = await h.call(a, 'DELETE', '/api/v1/field/spool/slot')
    assert.equal(again.status, 404)
    assert.deepEqual(Object.keys(again.body), ['message'])
    assert.equal(
      (await h.call(a, 'GET', '/api/v1/field/spool/slot/values')).status,
      404,
    )
  })

  it('collects the distinct values of a text field across records', async () => {
    await h.call(a, 'POST', '/api/v1/field/vendor/note', {
      name: 'Note',
      field_type: 'text',
    })
    const one = await seedInventory(h, a, 'N1')
    const two = await seedInventory(h, a, 'N2')
    await h.call(a, 'PATCH', `/api/v1/vendor/${one.vendor.id}`, {
      extra: { note: '"red"' },
    })
    await h.call(a, 'PATCH', `/api/v1/vendor/${two.vendor.id}`, {
      extra: { note: '"blue"' },
    })
    const values = await h.call(
      aRead,
      'GET',
      '/api/v1/field/vendor/note/values',
    )
    assert.deepEqual(values.body, ['blue', 'red'])
    assert.deepEqual(
      (await h.call(b, 'GET', '/api/v1/field/vendor/note/values')).status,
      404,
    )
  })

  it('validates path, body and the registry rules', async () => {
    const entity = await h.call(aRead, 'GET', '/api/v1/field/printer')
    assert.equal(entity.status, 422)
    assert.equal(entity.body.detail[0].type, 'enum')
    assert.deepEqual(entity.body.detail[0].loc, ['path', 'entity_type'])
    const key = await h.call(a, 'POST', '/api/v1/field/spool/Bad-Key', {
      name: 'x',
      field_type: 'text',
    })
    assert.equal(key.status, 422)
    assert.equal(key.body.detail[0].type, 'string_pattern_mismatch')
    const long = await h.call(
      a,
      'DELETE',
      `/api/v1/field/spool/${'a'.repeat(65)}`,
    )
    assert.equal(long.body.detail[0].type, 'string_too_long')
    const missing = await h.call(a, 'POST', '/api/v1/field/spool/x', {})
    assert.equal(missing.status, 422)
    assert.deepEqual(
      missing.body.detail.map((d: { loc: string[] }) => d.loc),
      [
        ['body', 'name'],
        ['body', 'field_type'],
      ],
    )
    const badType = await h.call(a, 'POST', '/api/v1/field/spool/x', {
      name: 'x',
      field_type: 'colour',
    })
    assert.equal(badType.body.detail[0].type, 'enum')
    const empty = await h.call(a, 'POST', '/api/v1/field/spool/x', {
      name: '',
      field_type: 'text',
    })
    assert.equal(empty.body.detail[0].type, 'string_too_short')
    const noBody = await h.call(a, 'POST', '/api/v1/field/spool/x')
    assert.equal(noBody.status, 422)
    assert.equal(noBody.body.detail[0].type, 'missing')
    const choices = await h.call(a, 'POST', '/api/v1/field/spool/x', {
      name: 'x',
      field_type: 'choice',
      choices: [],
    })
    assert.equal(choices.status, 422)

    // 400: registry rules.
    assert.equal(
      (
        await h.call(a, 'POST', '/api/v1/field/spool/c1', {
          name: 'x',
          field_type: 'choice',
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await h.call(a, 'POST', '/api/v1/field/spool/c2', {
          name: 'x',
          field_type: 'text',
          choices: ['a'],
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await h.call(a, 'POST', '/api/v1/field/spool/c3', {
          name: 'x',
          field_type: 'integer',
          default_value: '"a"',
        })
      ).status,
      400,
    )
    await h.call(a, 'POST', '/api/v1/field/spool/typed', {
      name: 'x',
      field_type: 'integer',
    })
    const retype = await h.call(a, 'POST', '/api/v1/field/spool/typed', {
      name: 'x',
      field_type: 'text',
    })
    assert.equal(retype.status, 400)
    assert.deepEqual(Object.keys(retype.body), ['message'])

    // Read-only credentials never change the registry.
    const denied = await h.call(aRead, 'POST', '/api/v1/field/spool/y', {
      name: 'y',
      field_type: 'text',
    })
    assert.equal(denied.status, 403)
    assert.equal(
      (await h.call(aRead, 'DELETE', '/api/v1/field/spool/typed')).status,
      403,
    )
    assert.equal(
      (await h.call(a, 'PUT', '/api/v1/field/spool/typed')).status,
      405,
    )
  })

  it('shows the registry through the extra_fields_* settings, read-only', async () => {
    const view = await h.call(
      aRead,
      'GET',
      '/api/v1/setting/extra_fields_spool',
    )
    assert.equal(view.body.type, 'array')
    assert.equal(view.body.is_set, true)
    const parsed = JSON.parse(view.body.value)
    assert.ok(parsed.some((f: { key: string }) => f.key === 'finish'))
    const write = await h.call(
      a,
      'POST',
      '/api/v1/setting/extra_fields_spool',
      undefined,
      encode([]),
    )
    assert.equal(write.status, 400)
    assert.equal(
      (await h.call(b, 'GET', '/api/v1/setting/extra_fields_spool')).body
        .is_set,
      false,
    )
  })
})
