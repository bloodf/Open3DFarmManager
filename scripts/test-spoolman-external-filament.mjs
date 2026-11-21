// Run the contract checks and external HTTP mock entirely inside one disposable
// Docker container. No host port, external service, or printer is involved.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (process.argv[2] !== '--inside') {
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim()
  const image = docker('image', 'inspect', 'node:22-bookworm', '--format', '{{.Id}}')
  const name = `tou562-external-${randomUUID()}`
  const root = fileURLToPath(new URL('../', import.meta.url))
  const ledger = process.env.TOU562_LEDGER ?? '/tmp/tou562-worker-ledger.jsonl'
  const log = (data) => appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n')
  log({ resource: 'container', name, image, action: 'creating' })
  let id
  try {
    id = docker('create', '--label', `tou562.owner=${name}`, '--name', name, '--network', 'none', '--mount', `type=bind,src=${root},dst=/repo,readonly`, '-w', '/repo', image, 'node', 'scripts/test-spoolman-external-filament.mjs', '--inside')
  } catch (error) {
    // A timed-out create can finish server-side. Remove only an exact name
    // whose task ownership label matches this invocation.
    try {
      const owner = docker('inspect', name, '--format', '{{index .Config.Labels "tou562.owner"}}')
      if (owner === name) { docker('rm', '-f', name); log({ resource: 'container', name, action: 'removed-after-create-error' }) }
    } catch {}
    log({ resource: 'container', name, action: 'create-error', error: String(error) })
    throw error
  }
  log({ resource: 'container', name, id, image, reason: 'isolated mock external service and test runner; no host service', action: 'created' })
  try {
    const run = spawnSync('docker', ['start', '--attach', id], { stdio: 'inherit' })
    if (run.status !== 0) throw new Error(`Contract check failed: ${run.status}`)
  } finally {
    docker('rm', '-f', id)
    log({ resource: 'container', name, id, action: 'removed' })
  }
} else {
  const { createExternalFilamentCatalog, createExternalFilamentModule } = await import('../apps/farm/server/utils/spool-library/legacy-api/external-filament.ts')
  const { handleLegacyRequest } = await import('../apps/farm/server/utils/spool-library/legacy-handler.ts')
  const tokenA = `sl1.${'a'.repeat(32)}.${'A'.repeat(43)}`
  const tokenB = `sl1.${'b'.repeat(32)}.${'B'.repeat(43)}`
  const sample = [
    { id: 'one', manufacturer: 'PolyMaker', name: 'Blue Sky', material: 'PLA', density: 1.24, weight: 1000, diameter: 1.75 },
    { id: 'two', manufacturer: 'PolyMaker', name: 'Blue', material: 'PETG', density: 1.27, weight: 750, diameter: 1.75, color_hex: '123456' },
    { id: 'three', manufacturer: 'Other', name: 'Blue Sky', material: 'PLA', density: 1.2, weight: 500, diameter: 1.75 },
  ]
  let version = 1
  let status = 200
  let invalid = false
  let requests = []
  let cacheControl = 'max-age=0'
  let invalidMaterials = false
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    if (status !== 200) { res.writeHead(status); res.end(); return }
    const etag = `"v${version}"`
    res.setHeader('cache-control', cacheControl)
    res.setHeader('last-modified', 'Wed, 21 Oct 2015 07:28:00 GMT')
    res.setHeader('etag', etag)
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return }
    res.setHeader('content-type', 'application/json')
    const data = req.url === '/filaments.json' ? (invalid ? [{}] : sample.slice(0, version === 1 ? 3 : 1)) : invalidMaterials ? [{}] : [{ material: 'PLA', density: 1.24 }]
    res.end(JSON.stringify(data))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const catalog = createExternalFilamentCatalog(`http://127.0.0.1:${address.port}/`)
    const module = createExternalFilamentModule(catalog)
    const storage = { async withScope(authority, callback) { if (![tokenA, tokenB].includes(authority.token)) return { ok: false, reason: 'unauthorized' }; return callback({ access: 'read' }) } }
    const call = (path, token = tokenA, method = 'GET') => { const url = new URL(path, 'http://local'); return handleLegacyRequest(storage, { method, pathname: `/spoolman/${token}${url.pathname}`, query: url.searchParams }, [module]) }
    assert.equal((await call('/api/v1/external/filament')).status, 500)
    assert.deepEqual((await call('/api/v1/external/filament/search?query=pla')).body, [])
    await catalog.refresh()
    const all = await call('/api/v1/external/filament?ignored=1')
    assert.equal(all.status, 200)
    assert.equal(all.headers['content-type'], 'application/json')
    assert.equal(Number(all.headers['content-length']), Buffer.byteLength(JSON.stringify(all.body)))
    assert.ok(all.headers.etag && all.headers['last-modified'])
    // FileResponse emits the normalized full model, including null defaults;
    // search uses the response model with null values excluded.
    assert.deepEqual(all.body[0], {
      ...sample[0], spool_weight: null, spool_type: null, color_hex: null,
      color_hexes: null, extruder_temp: null, bed_temp: null, finish: null,
      multi_color_direction: null, pattern: null, translucent: false, glow: false,
    })
    assert.equal(all.headers['accept-ranges'], 'bytes')
    // Range/If-Range requests cannot reach this module until the dispatcher
    // carries request headers; accept-ranges is metadata only here.
    const search = await call('/api/v1/external/filament/search?query=SKY%20poly%20PLA&limit=1')
    assert.equal(search.status, 200)
    assert.equal(search.headers['x-total-count'], '1')
    assert.equal(search.body[0].id, 'one')
    assert.equal('spool_weight' in search.body[0], false)
    assert.equal((await call('/api/v1/external/filament/search?query=blue&limit=1&offset=1')).body[0].id, 'two')
    assert.equal((await call('/api/v1/external/filament/search?query=%20%20')).headers['x-total-count'], '0')
    assert.equal((await call('/api/v1/external/filament/search?query=nomatch')).headers['x-total-count'], '0')
    assert.equal((await call('/api/v1/external/filament/search?query=bad&query=pla')).headers['x-total-count'], '2')
    const invalidQuery = await call('/api/v1/external/filament/search?limit=0&offset=-1')
    assert.equal(invalidQuery.status, 422)
    assert.deepEqual(invalidQuery.body.detail, [
      { type: 'missing', loc: ['query', 'query'], msg: 'Field required', input: null },
      { type: 'greater_than_equal', loc: ['query', 'limit'], msg: 'Input should be greater than or equal to 1', input: '0', ctx: { ge: 1 } },
      { type: 'greater_than_equal', loc: ['query', 'offset'], msg: 'Input should be greater than or equal to 0', input: '-1', ctx: { ge: 0 } },
    ])
    assert.equal((await call('/api/v1/external/filament/search?query=x&limit=101')).body.detail[0].type, 'less_than_equal')
    assert.equal((await call('/api/v1/external/filament/search?query=x&limit=bad')).body.detail[0].type, 'int_parsing')
    assert.deepEqual(await call('/api/v1/external/filament', tokenA, 'POST'), { status: 405, body: { detail: 'Method Not Allowed' }, headers: { allow: 'GET' } })
    assert.equal((await call('/api/v1/external/filament', 'invalid-secret')).status, 401)
    assert.deepEqual((await call('/api/v1/external/filament', tokenB)).body, all.body)
    await catalog.refresh()
    assert.ok(requests.some((r) => r.headers['if-none-match'] === '"v1"'))
    assert.ok(requests.some((r) => r.headers['if-modified-since'] === 'Wed, 21 Oct 2015 07:28:00 GMT'))
    version = 2
    await catalog.refresh()
    assert.equal((await call('/api/v1/external/filament')).body.length, 1)
    status = 503
    await catalog.refresh()
    assert.equal((await call('/api/v1/external/filament')).body.length, 1)
    status = 200
    version = 3
    invalid = true
    await assert.rejects(catalog.refresh())
    assert.equal((await call('/api/v1/external/filament')).body.length, 1)
    invalid = false
    invalidMaterials = true
    version = 4
    await assert.rejects(catalog.refresh())
    assert.equal((await call('/api/v1/external/filament')).body.length, 1)

    invalidMaterials = false
    const original = { ...sample[0] }
    Object.assign(sample[0], {
      spool_weight: 220, spool_type: 'plastic', color_hex: 'abcdef',
      color_hexes: ['abcdef', '123456'], extruder_temp: 210, bed_temp: 50,
      finish: 'matte', multi_color_direction: 'coaxial', pattern: 'marble',
      translucent: true, glow: true, ignored: 'discarded',
    })
    version = 5
    await catalog.refresh()
    const full = (await call('/api/v1/external/filament')).body[0]
    const { ignored, ...expected } = sample[0]
    assert.deepEqual(full, expected)
    for (const [field, value] of Object.entries({ spool_type: 'metal', finish: 'glossy', multi_color_direction: 'longitudinal', pattern: 'sparkle' })) sample[0][field] = value
    version = 6
    await catalog.refresh()
    assert.equal((await call('/api/v1/external/filament')).body[0].spool_type, 'metal')
    sample[0].spool_type = 'cardboard'
    version = 7
    await catalog.refresh()
    assert.equal((await call('/api/v1/external/filament')).body[0].spool_type, 'cardboard')
    for (const field of ['spool_type', 'finish', 'multi_color_direction', 'pattern']) {
      const valid = sample[0][field]
      sample[0][field] = 'invalid'
      version++
      await assert.rejects(catalog.refresh())
      assert.equal((await call('/api/v1/external/filament')).body[0][field], valid)
      sample[0][field] = valid
    }
    version++
    sample[0].glow = null
    await assert.rejects(catalog.refresh())
    assert.equal((await call('/api/v1/external/filament')).body[0].glow, true)
    for (const key of Object.keys(sample[0])) delete sample[0][key]
    Object.assign(sample[0], original)

    // Source HTTP cache behavior is separate from the returned file headers.
    cacheControl = 'max-age=60'
    version++
    const fresh = createExternalFilamentCatalog(`http://127.0.0.1:${address.port}/`)
    await fresh.refresh()
    const count = requests.length
    await fresh.refresh()
    assert.equal(requests.length, count)
    cacheControl = 'no-cache, max-age=60'
    const revalidate = createExternalFilamentCatalog(`http://127.0.0.1:${address.port}/`)
    await revalidate.refresh()
    const beforeRevalidate = requests.length
    await revalidate.refresh()
    assert.equal(requests.length, beforeRevalidate + 2)
    assert.ok(requests.slice(beforeRevalidate).every((r) => r.headers['if-none-match']))
    cacheControl = 'no-store'
    const uncached = createExternalFilamentCatalog(`http://127.0.0.1:${address.port}/`)
    await uncached.refresh()
    const afterNoStore = requests.length
    await uncached.refresh()
    assert.equal(requests.length, afterNoStore + 2)
    status = 404
    await assert.rejects(uncached.refresh())
    assert.ok(requests.every((r) => !JSON.stringify(r).includes(tokenA) && !JSON.stringify(r).includes(tokenB)))
    console.log('Spoolman external filament contract checks passed')
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}
