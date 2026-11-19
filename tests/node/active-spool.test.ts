import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ActiveSpool,
  ActiveSpools,
  activeSpoolsFromMaterials,
} from '../../packages/farm-protocol/src/status.ts'
import { parseMoonrakerActiveSpoolId } from '../../packages/connector/src/moonraker/active-spool.ts'
import { createActiveSpoolAssignmentStore } from '../../packages/connector/src/spoolman/active-assignments.ts'
import { resolveActiveSpools } from '../../packages/connector/src/spoolman/resolve-active-spools.ts'
import { getSpoolmanMaterials } from '../../packages/connector/src/runtime/spoolman-materials.ts'
import { SpoolmanSpool } from '../../packages/connector/src/spoolman/read.ts'
import {
  getIntegrationPrinterStatus,
  type IntegrationPrinterReader,
} from '../../apps/farm/server/utils/integration-printers.ts'
import type {
  IntegrationPrincipal,
  IntegrationPrinterRow,
} from '../../apps/farm/server/utils/integration-auth.ts'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'

const spool = SpoolmanSpool.parse({
  id: 42,
  filament: { id: 1, name: 'Red PLA', material: 'PLA', color_hex: 'aabbcc' },
  initial_weight: 1000,
  remaining_weight: 500,
  location: 'shelf-a',
  archived: false,
})

const other = SpoolmanSpool.parse({
  id: 7,
  filament: { id: 2, name: 'PETG', material: 'PETG', color_hex: '112233' },
  initial_weight: 1000,
  remaining_weight: 800,
  location: 'ams',
  archived: false,
})

test('Moonraker active spool is reported through status projection', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/server/spoolman/spool_id') {
      res.end(JSON.stringify({ result: { spool_id: 42 } }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/server/spoolman/spool_id`,
    )
    const body = await response.json()
    const spoolId = parseMoonrakerActiveSpoolId(body)
    assert.equal(spoolId, 42)
    const active = resolveActiveSpools({
      moonrakerSpoolId: spoolId,
      assignments: [],
      inventory: [spool, other],
    })
    assert.deepEqual(active, [
      {
        slot: 'external',
        spoolId: 42,
        name: 'Red PLA',
        material: 'PLA',
        colorHex: 'aabbcc',
        remainingGrams: 500,
        remainingPercent: 50,
      },
    ])
    ActiveSpools.parse(active)
    const materials = await getSpoolmanMaterials(async () => spoolId, {
      kind: 'observed',
      ageMs: 0,
      inventory: {
        items: [spool, other],
        farmId: '00000000-0000-4000-8000-000000000001',
        serviceId: '00000000-0000-4000-8000-000000000002',
        observedFrom: 0,
        observedThrough: 0,
      },
    })
    assert.deepEqual(materials, [
      {
        slot: 'external',
        active: true,
        materialType: 'PLA',
        colorHex: 'AABBCCFF',
        remainingPercent: 50,
      },
    ])
    assert.deepEqual(activeSpoolsFromMaterials(materials), [
      {
        slot: 'external',
        material: 'PLA',
        colorHex: 'aabbcc',
        remainingPercent: 50,
      },
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('manual assignment survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'active-spool-assign-'))
  const path = join(dir, 'assignments.json')
  try {
    const store = createActiveSpoolAssignmentStore(path)
    await store.assign({
      printerKey: 'printer-a',
      slot: 'ams:0:0',
      spoolId: 7,
    })
    await store.assign({
      printerKey: 'printer-a',
      slot: 'ams:0:1',
      spoolId: 42,
    })
    store.forget()
    const reopened = createActiveSpoolAssignmentStore(path)
    assert.deepEqual(await reopened.listForPrinter('printer-a'), [
      { printerKey: 'printer-a', slot: 'ams:0:0', spoolId: 7 },
      { printerKey: 'printer-a', slot: 'ams:0:1', spoolId: 42 },
    ])
    const raw = await readFile(path, 'utf8')
    assert.match(raw, /"version":1/)
    const resolved = resolveActiveSpools({
      moonrakerSpoolId: null,
      assignments: await reopened.listForPrinter('printer-a'),
      inventory: [spool, other],
    })
    assert.equal(resolved.length, 2)
    assert.equal(resolved[0]?.slot, 'ams:0:0')
    assert.equal(resolved[0]?.spoolId, 7)
    assert.equal(resolved[1]?.slot, 'ams:0:1')
    assert.equal(resolved[1]?.spoolId, 42)
    const materials = await getSpoolmanMaterials(
      async () => null,
      {
        kind: 'observed',
        ageMs: 0,
        inventory: {
          items: [spool, other],
          farmId: '00000000-0000-4000-8000-000000000001',
          serviceId: '00000000-0000-4000-8000-000000000002',
          observedFrom: 0,
          observedThrough: 0,
        },
      },
      await reopened.listForPrinter('printer-a'),
    )
    assert.equal(materials?.length, 2)
    assert.equal(materials?.[0]?.slot, 'ams:0:0')
    assert.equal(materials?.[1]?.slot, 'ams:0:1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status schema includes active spool per tool', async () => {
  const openapi = await readFile(
    new URL('../../docs/api/openapi-v1.yaml', import.meta.url),
    'utf8',
  )
  assert.match(
    openapi,
    /activeSpools:\n\s+type: array\n\s+description: Active spool per tool/,
  )
  assert.match(openapi, /ActiveSpool:\n[\s\S]*?required: \[slot\]/)
  assert.match(openapi, /spoolId:\n\s+type: integer/)

  const perTool = ActiveSpools.parse([
    ActiveSpool.parse({
      slot: 'ams:0:0',
      spoolId: 7,
      material: 'PETG',
      colorHex: '112233',
      remainingPercent: 80,
    }),
    ActiveSpool.parse({
      slot: 'ams:0:1',
      spoolId: 42,
      material: 'PLA',
      colorHex: 'aabbcc',
      remainingGrams: 500,
    }),
  ])
  assert.equal(perTool.length, 2)

  const farmA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const printerA = 'aaaaaaaa-0000-4000-8000-000000000001'
  const grant: IntegrationGrant = {
    id: 'grant',
    appId: 'app',
    farmId: farmA,
    printerAssignmentId: null,
    scopes: ['printers:read'],
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
  }
  const principal: IntegrationPrincipal = {
    appId: 'app',
    scopes: ['printers:read'],
    grants: [grant],
  }
  const row: IntegrationPrinterRow = {
    id: printerA,
    farmId: farmA,
    printerKey: 'printer-a',
    sandbox: false,
    state: {
      printerKey: 'printer-a',
      state: 'idle',
      progress: 0,
      observedAt: 10,
      materials: [
        {
          slot: 'ams:0:0',
          materialType: 'PETG',
          colorHex: '112233FF',
          remainingPercent: 80,
          active: true,
        },
        {
          slot: 'ams:0:1',
          materialType: 'PLA',
          colorHex: 'AABBCCFF',
          remainingPercent: 50,
        },
      ],
    },
    observedAt: 10,
  }
  const store: IntegrationPrinterReader = {
    async readPrinters() {
      return [row]
    },
    async readPrinter(id) {
      return id === printerA ? row : null
    },
  }
  const status = await getIntegrationPrinterStatus(principal, store, printerA)
  assert.ok(!('error' in status))
  assert.deepEqual(status.activeSpools, [
    {
      slot: 'ams:0:0',
      material: 'PETG',
      colorHex: '112233',
      remainingPercent: 80,
    },
    {
      slot: 'ams:0:1',
      material: 'PLA',
      colorHex: 'aabbcc',
      remainingPercent: 50,
    },
  ])
})
