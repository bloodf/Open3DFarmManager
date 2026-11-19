// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { createLoopbackSpoolmanReader } from '../../packages/connector/src/spoolman/http-read.ts'
import {
  assertLoopbackAddress,
  installNetworkGuard,
  startMock,
  startSpoolmanMock,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'
import seed from '../../infra/sim/spoolman/seed.json' with { type: 'json' }

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')

const readerContext = {
  farmId: '00000000-0000-4000-8000-000000000001',
  serviceId: '00000000-0000-4000-8000-000000000002',
  limit: 200,
}

test('Spoolman mock exposes /api/v1/info, /health, and seeded fixtures matching sim:seed', async () => {
  const mock = await startMock('spoolman')
  try {
    const health = await fetch(`${mock.origin}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'healthy' })

    const apiHealth = await fetch(`${mock.origin}/api/v1/health`)
    assert.equal(apiHealth.status, 200)
    assert.deepEqual(await apiHealth.json(), { status: 'healthy' })

    const infoRes = await fetch(`${mock.origin}/api/v1/info`)
    assert.equal(infoRes.status, 200)
    const info = await infoRes.json()
    assert.equal(typeof info.version, 'string')
    assert.equal(info.db_type, 'sqlite')

    const vendors = await (await fetch(`${mock.origin}/api/v1/vendor`)).json()
    const filaments = await (
      await fetch(`${mock.origin}/api/v1/filament`)
    ).json()
    const spools = await (
      await fetch(`${mock.origin}/api/v1/spool?allow_archived=true`)
    ).json()

    assert.deepEqual(
      vendors.map((v) => v.name),
      seed.vendors.map((v) => v.name),
    )
    assert.deepEqual(
      filaments.map((f) => f.name),
      seed.filaments.map((f) => f.name),
    )
    assert.deepEqual(
      spools.map((s) => s.comment),
      seed.spools.map((s) => s.comment),
    )
    assert.deepEqual(
      spools.map((s) => s.remaining_weight),
      [1000, 900, 800, 700, 600, 500],
    )
  } finally {
    await mock.close()
  }
})

test('Spoolman mock supports list, get, create, and patch for vendors, filaments, and spools', async () => {
  const mock = await startSpoolmanMock({ seeded: false })
  try {
    // Empty initially
    assert.deepEqual(
      await (await fetch(`${mock.origin}/api/v1/vendor`)).json(),
      [],
    )
    assert.deepEqual(
      await (await fetch(`${mock.origin}/api/v1/filament`)).json(),
      [],
    )
    assert.deepEqual(
      await (await fetch(`${mock.origin}/api/v1/spool`)).json(),
      [],
    )

    // Create + get + patch vendor
    const createVendorRes = await fetch(`${mock.origin}/api/v1/vendor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mock Vendor', comment: 'v1' }),
    })
    assert.equal(createVendorRes.status, 200)
    const vendor = await createVendorRes.json()
    assert.equal(vendor.id, 1)
    assert.equal(vendor.name, 'Mock Vendor')

    const getVendorRes = await fetch(
      `${mock.origin}/api/v1/vendor/${vendor.id}`,
    )
    assert.equal(getVendorRes.status, 200)
    assert.equal((await getVendorRes.json()).comment, 'v1')

    const patchVendorRes = await fetch(
      `${mock.origin}/api/v1/vendor/${vendor.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Vendor' }),
      },
    )
    assert.equal(patchVendorRes.status, 200)
    assert.equal((await patchVendorRes.json()).name, 'Renamed Vendor')

    // Create + get + patch filament (and verify missing vendor FK rejection)
    const badFilamentRes = await fetch(`${mock.origin}/api/v1/filament`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', vendor_id: 999 }),
    })
    assert.equal(badFilamentRes.status, 422)

    const createFilamentRes = await fetch(`${mock.origin}/api/v1/filament`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Mock PLA',
        vendor_id: vendor.id,
        material: 'PLA',
        density: 1.24,
        diameter: 1.75,
        weight: 1000,
        color_hex: '112233',
      }),
    })
    assert.equal(createFilamentRes.status, 200)
    const filament = await createFilamentRes.json()
    assert.equal(filament.vendor.name, 'Renamed Vendor')

    const patchFilamentRes = await fetch(
      `${mock.origin}/api/v1/filament/${filament.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ material: 'PLA+' }),
      },
    )
    assert.equal(patchFilamentRes.status, 200)
    assert.equal((await patchFilamentRes.json()).material, 'PLA+')

    const getFilamentRes = await fetch(
      `${mock.origin}/api/v1/filament/${filament.id}`,
    )
    assert.equal(getFilamentRes.status, 200)
    assert.equal((await getFilamentRes.json()).material, 'PLA+')

    // Create + get + patch spool + allow_archived filtering
    const createSpoolRes = await fetch(`${mock.origin}/api/v1/spool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filament_id: filament.id,
        initial_weight: 1000,
        used_weight: 250,
        location: 'Shelf A',
        comment: 'spool-a',
      }),
    })
    assert.equal(createSpoolRes.status, 200)
    const spool = await createSpoolRes.json()
    assert.equal(spool.remaining_weight, 750)
    assert.equal(spool.filament.material, 'PLA+')

    const patchSpoolRes = await fetch(
      `${mock.origin}/api/v1/spool/${spool.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true, remaining_weight: 700 }),
      },
    )
    assert.equal(patchSpoolRes.status, 200)
    const patchedSpool = await patchSpoolRes.json()
    assert.equal(patchedSpool.archived, true)
    assert.equal(patchedSpool.remaining_weight, 700)
    assert.equal(patchedSpool.used_weight, 300)

    assert.deepEqual(
      await (await fetch(`${mock.origin}/api/v1/spool`)).json(),
      [],
    )
    const withArchived = await (
      await fetch(`${mock.origin}/api/v1/spool?allow_archived=true`)
    ).json()
    assert.equal(withArchived.length, 1)

    const getSpoolRes = await fetch(`${mock.origin}/api/v1/spool/${spool.id}`)
    assert.equal(getSpoolRes.status, 200)
    assert.equal((await getSpoolRes.json()).id, spool.id)

    assert.equal((await fetch(`${mock.origin}/api/v1/spool/9999`)).status, 404)
  } finally {
    await mock.close()
  }
})

test('PUT /api/v1/spool/{id}/use reduces remaining_weight with Spoolman bookkeeping for seeded spools', async () => {
  const mock = await startSpoolmanMock({ seeded: true })
  try {
    // Seeded spool 1: initial 1000, used 0, remaining 1000
    const use1 = await fetch(`${mock.origin}/api/v1/spool/1/use`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ use_weight: 125.5 }),
    })
    assert.equal(use1.status, 200)
    const after1 = await use1.json()
    assert.equal(after1.used_weight, 125.5)
    assert.equal(after1.remaining_weight, 874.5)
    assert.ok(after1.first_used)
    assert.ok(after1.last_used)

    // Seeded spool 2: initial 1000, used 100, remaining 900
    const use2 = await fetch(`${mock.origin}/api/v1/spool/2/use`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ use_weight: 49.5 }),
    })
    assert.equal(use2.status, 200)
    const after2 = await use2.json()
    assert.equal(after2.used_weight, 149.5)
    assert.equal(after2.remaining_weight, 850.5)

    // Subsequent use accumulates on the same spool
    const use2Again = await fetch(`${mock.origin}/api/v1/spool/2/use`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ use_weight: 50.5 }),
    })
    assert.equal(use2Again.status, 200)
    const after2Again = await use2Again.json()
    assert.equal(after2Again.used_weight, 200)
    assert.equal(after2Again.remaining_weight, 800)

    // Over-consuming clamps remaining_weight at 0 while recording used_weight
    const use6 = await fetch(`${mock.origin}/api/v1/spool/6/use`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ use_weight: 600 }),
    })
    assert.equal(use6.status, 200)
    const after6 = await use6.json()
    assert.equal(after6.used_weight, 1100)
    assert.equal(after6.remaining_weight, 0)

    // use_length computes weight from filament diameter & density
    const useLength = await fetch(`${mock.origin}/api/v1/spool/3/use`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ use_length: 1000 }),
    })
    assert.equal(useLength.status, 200)
    const after3 = await useLength.json()
    const expectedGrams =
      ((Math.PI * Math.pow(1.75 / 2, 2) * 1000) / 1000) * 1.27
    assert.ok(Math.abs(after3.used_weight - (200 + expectedGrams)) < 1e-6)
    assert.ok(Math.abs(after3.remaining_weight - (800 - expectedGrams)) < 1e-6)

    // Invalid payloads rejected
    const badBoth = await fetch(`${mock.origin}/api/v1/spool/1/use`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ use_weight: 10, use_length: 10 }),
    })
    assert.equal(badBoth.status, 400)
  } finally {
    await mock.close()
  }
})

test('Optional auth header protects REST and WebSocket endpoints while leaving /health reachable', async () => {
  const mock = await startSpoolmanMock({
    seeded: true,
    auth: { bearer: 'synth-token-123' },
  })
  try {
    assert.equal((await fetch(`${mock.origin}/health`)).status, 200)
    assert.equal((await fetch(`${mock.origin}/api/v1/info`)).status, 401)
    assert.equal((await fetch(`${mock.origin}/api/v1/spool`)).status, 401)

    const wrongRes = await fetch(`${mock.origin}/api/v1/spool`, {
      headers: { authorization: 'Bearer wrong' },
    })
    assert.equal(wrongRes.status, 401)

    const okRes = await fetch(`${mock.origin}/api/v1/spool`, {
      headers: { authorization: 'Bearer synth-token-123' },
    })
    assert.equal(okRes.status, 200)
    assert.equal((await okRes.json()).length, 6)

    // API key mode
    mock.control.setAuth({ apiKey: 'synth-api-key' })
    assert.equal((await fetch(`${mock.origin}/api/v1/spool`)).status, 401)
    const apiKeyOk = await fetch(`${mock.origin}/api/v1/spool`, {
      headers: { 'x-api-key': 'synth-api-key' },
    })
    assert.equal(apiKeyOk.status, 200)
  } finally {
    await mock.close()
  }
})

test('Fault hooks cover 500, timeout, and schema drift against Connector reader', async () => {
  const mock = await startSpoolmanMock({ seeded: true })
  const read = (timeoutMs = 2000) =>
    createLoopbackSpoolmanReader({
      origin: mock.origin,
      context: readerContext,
      timeoutMs,
    })()

  try {
    // Baseline succeeds
    assert.equal((await read()).items.length, 6)

    // 1. 500 fault
    mock.control.faults.setFault({
      type: 'refuse',
      statusCode: 500,
      message: 'Synthetic 500',
    })
    const err500 = await fetch(`${mock.origin}/api/v1/spool`)
    assert.equal(err500.status, 500)
    await assert.rejects(read(), /^Error: Local Spoolman read failed$/)
    mock.control.faults.clearFaults()

    // 2. Timeout fault (stall)
    mock.control.faults.setFault({ type: 'stall' })
    await assert.rejects(read(80), /^Error: Local Spoolman read failed$/)
    mock.control.faults.clearFaults()

    // 3. Schema drift faults
    for (const mode of [
      'wrapped-list',
      'missing-filament',
      'missing-archived',
      'string-weights',
      'bad-color-hex',
      'descending-ids',
      'duplicate-id',
    ]) {
      mock.control.setSchemaDrift(mode)
      await assert.rejects(
        read(),
        /^Error: Local Spoolman read failed$/,
        `Expected reader to reject schema drift mode: ${mode}`,
      )
    }

    mock.control.setSchemaDrift('missing-info-version')
    const driftedInfo = await (await fetch(`${mock.origin}/api/v1/info`)).json()
    assert.equal('version' in driftedInfo, false)

    mock.control.setSchemaDrift(null)
    assert.equal((await read()).items.length, 6)
  } finally {
    await mock.close()
  }
})

test('Network guard and 50x start/close cycles leak no non-loopback sockets or handles', async () => {
  installNetworkGuard()
  try {
    for (let i = 0; i < 50; i++) {
      const mock = await startSpoolmanMock()
      assertLoopbackAddress({
        address: '127.0.0.1',
        port: mock.ports.default,
        family: 'IPv4',
      })
      await mock.close()
    }
  } finally {
    uninstallNetworkGuard()
  }
})

test('node packages/sim-tools/src/spoolman-cli.ts passes against empty and seeded mocks', async () => {
  for (const seeded of [false, true]) {
    const mock = await startSpoolmanMock({ seeded })
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['packages/sim-tools/src/spoolman-cli.ts'],
        {
          cwd: root,
          env: {
            ...process.env,
            SIM_SPOOLMAN_URL: mock.origin,
          },
          timeout: 15_000,
        },
      )
      assert.match(
        stdout,
        /SIM_SPOOLMAN_OK: 2 vendors, 4 filaments, 6 seeded spools/,
      )
    } finally {
      await mock.close()
    }
  }
})

test('scripts/test-spoolman-node.ts and scripts/test-spoolman-reader.ts run on the mock by default and preserve docker opt-in', async () => {
  const cleanEnv = { ...process.env }
  delete cleanEnv.SPOOLMAN_SYNTHETIC_TEST_ORIGIN
  delete cleanEnv.SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE
  delete cleanEnv.OPENFARM_SIM

  const nodeRun = await execFileAsync(
    process.execPath,
    ['scripts/test-spoolman-node.ts'],
    { cwd: root, env: cleanEnv, timeout: 15_000 },
  )
  assert.equal(JSON.parse(nodeRun.stdout.trim()).result, 'passed')

  const readerRun = await execFileAsync(
    process.execPath,
    ['scripts/test-spoolman-reader.ts'],
    { cwd: root, env: cleanEnv, timeout: 15_000 },
  )
  assert.equal(JSON.parse(readerRun.stdout.trim()).result, 'passed')

  // Docker opt-in still requires explicit disposable origin guard
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/test-spoolman-node.ts'], {
      cwd: root,
      env: { ...cleanEnv, OPENFARM_SIM: 'docker' },
      timeout: 10_000,
    }),
    /Explicit disposable synthetic Spoolman origin required/,
  )
})

test(
  'scripts/test-spoolman-provider.ts runs on the mock by default',
  { timeout: 60_000 },
  async () => {
    const cleanEnv = { ...process.env }
    delete cleanEnv.SPOOLMAN_SYNTHETIC_TEST_ORIGIN
    delete cleanEnv.SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE
    delete cleanEnv.OPENFARM_SIM

    const providerRun = await execFileAsync(
      process.execPath,
      ['scripts/test-spoolman-provider.ts'],
      { cwd: root, env: cleanEnv, timeout: 45_000 },
    )
    const receipt = JSON.parse(providerRun.stdout.trim())
    assert.equal(receipt.result, 'passed')
    assert.deepEqual(receipt.providerMethods, ['GET'])
    assert.equal(receipt.staleOnClose, true)
  },
)
