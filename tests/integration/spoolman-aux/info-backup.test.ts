import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { normalizeBundle } from '../../../apps/farm/server/utils/spool-library-import/bundle.ts'
import { seedInventory, startHarness, type Harness } from './harness.ts'

describe('info, health and backup', () => {
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

  it('health answers the pinned example and nothing else', async () => {
    const r = await h.call(aRead, 'GET', '/api/v1/health')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { status: 'healthy' })
  })

  it('info carries every required Info field and no host path', async () => {
    const r = await h.call(aRead, 'GET', '/api/v1/info')
    assert.equal(r.status, 200)
    for (const key of [
      'version',
      'debug_mode',
      'automatic_backups',
      'data_dir',
      'logs_dir',
      'backups_dir',
      'db_type',
      'external_db_name',
    ])
      assert.ok(key in r.body, `Info.${key}`)
    assert.equal(r.body.version, '0.27.1')
    assert.equal(r.body.db_type, 'postgresql')
    assert.equal(r.body.update_available, false)
    assert.equal(r.body.data_dir, '')
    assert.equal(r.body.external_db_name, 'SpoolmanDB')
    assert.equal((await h.call(aRead, 'POST', '/api/v1/info')).status, 405)
  })

  it('unknown credentials and unclaimed paths keep the Message shape', async () => {
    const forged = await h.call(
      'sl1.00000000-0000-4000-8000-000000000000.' + 'A'.repeat(43),
      'GET',
      '/api/v1/info',
    )
    assert.equal(forged.status, 401)
    assert.deepEqual(forged.body, { message: 'Unauthorized' })
    const missing = await h.call(aRead, 'GET', '/api/v1/nope')
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { message: 'Not Found' })
  })

  it('backup returns this farm only, as a JSON export the importer accepts', async () => {
    const own = await seedInventory(h, a, 'Alpha', { location: 'Shelf A' })
    await seedInventory(h, b, 'Bravo', { location: 'Shelf B' })
    await h.call(a, 'POST', '/api/v1/field/spool/slot', {
      name: 'Slot',
      field_type: 'integer',
    })
    await h.call(a, 'POST', '/api/v1/setting/currency', undefined, {
      raw: JSON.stringify(JSON.stringify('USD')),
    })

    const r = await h.call(aRead, 'POST', '/api/v1/backup')
    assert.equal(r.status, 200)
    assert.equal(r.body.created, true)
    assert.equal(typeof r.body.path, 'string')
    const bundle = r.body.export
    assert.deepEqual(
      bundle.vendors.map((v: { name: string }) => v.name),
      ['Alpha Vendor'],
    )
    assert.equal(bundle.filaments.length, 1)
    assert.equal(bundle.spools.length, 1)
    assert.equal(bundle.spools[0].id, own.spool.id)
    assert.equal(bundle.fields.spool[0].key, 'slot')
    assert.equal(bundle.settings.currency.value, '"USD"')
    assert.equal(
      JSON.stringify(r.body).includes('Bravo'),
      false,
      'other farm leaked',
    )

    const parsed = normalizeBundle(bundle)
    assert.equal(parsed.ok, true, JSON.stringify(parsed))

    assert.equal((await h.call(aRead, 'GET', '/api/v1/backup')).status, 405)
    const other = await h.call(b, 'POST', '/api/v1/backup')
    assert.equal(JSON.stringify(other.body).includes('Alpha'), false)
  })
})
