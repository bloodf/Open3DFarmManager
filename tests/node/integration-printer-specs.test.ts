import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type {
  IntegrationPrincipal,
  IntegrationPrinterRow,
} from '../../apps/farm/server/utils/integration-auth.ts'
import {
  listIntegrationPrinters,
  type IntegrationPrinterReader,
} from '../../apps/farm/server/utils/integration-printers.ts'

const farm = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const grant: IntegrationGrant = {
  id: 'grant',
  appId: 'app',
  farmId: farm,
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

function row(
  n: number,
  state: Record<string, unknown>,
  sandbox = true,
): IntegrationPrinterRow {
  return {
    id: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
    farmId: farm,
    printerKey: `printer-${n}`,
    sandbox,
    state: {
      printerKey: `printer-${n}`,
      state: 'printing',
      progress: 0.5,
      observedAt: 1,
      ...state,
    },
    observedAt: 1,
  }
}

async function read(rows: IntegrationPrinterRow[]) {
  const reader: IntegrationPrinterReader = {
    async readPrinters() {
      return rows
    },
    async readPrinter() {
      return null
    },
  }
  const result = await listIntegrationPrinters(
    principal,
    reader,
    new URLSearchParams(),
  )
  assert.ok('data' in result)
  return result.data as Record<string, unknown>[]
}

test('simulator printers report the specs their connector knows', async () => {
  const [printer] = await read([
    row(1, {
      machine: {
        toolCount: 2,
        nozzleDiametersMm: [0.4, 0.6],
        bedSizeMm: { x: 256, y: 250, z: 256 },
      },
      materials: [{ slot: '1' }, { slot: '2' }, { slot: '3' }, { slot: '4' }],
    }),
  ])
  assert.deepEqual(printer!.specs, {
    buildVolumeMm: { x: 256, y: 250, z: 256 },
    nozzles: [{ diameterMm: 0.4 }, { diameterMm: 0.6 }],
    spoolSlots: 4,
    multicolor: true,
  })
})

test('single tool and slot is reported as not multicolour', async () => {
  const [printer] = await read([
    row(1, {
      machine: { toolCount: 1, nozzleDiametersMm: [0.4] },
      materials: [{ slot: 'ext' }],
    }),
  ])
  assert.deepEqual(printer!.specs, {
    nozzles: [{ diameterMm: 0.4 }],
    spoolSlots: 1,
    multicolor: false,
  })
})

test('unknown members are omitted individually', async () => {
  const [printer] = await read([
    row(1, { machine: { bedSizeMm: { x: 220, y: 220, z: 250 } } }),
    // One tool but no slot info: not enough to say multicolour either way.
  ])
  assert.deepEqual(printer!.specs, {
    buildVolumeMm: { x: 220, y: 220, z: 250 },
  })
  const [single] = await read([
    row(1, { machine: { toolCount: 1, nozzleDiametersMm: [0.4] } }),
  ])
  assert.deepEqual(single!.specs, { nozzles: [{ diameterMm: 0.4 }] })
})

test('a printer with unknown specs omits the specs object', async () => {
  const printers = await read([
    row(1, {}),
    row(2, { machine: { model: 'Only a name' } }, false),
    row(3, { state: 'not-a-state' } as never),
  ])
  for (const printer of printers) assert.ok(!('specs' in printer))
})

test('specs are documented and the spec version is bumped additively', () => {
  const spec = parse(
    readFileSync(
      new URL('../../docs/api/openapi-v1.yaml', import.meta.url),
      'utf8',
    ),
  ) as {
    info: { version: string }
    components: { schemas: Record<string, { properties?: object }> }
  }
  assert.equal(spec.info.version, '1.1.0')
  const printer = spec.components.schemas.Printer!
  assert.ok('specs' in printer.properties!)
  assert.deepEqual(
    Object.keys(spec.components.schemas.PrinterSpecs!.properties!).sort(),
    ['buildVolumeMm', 'multicolor', 'nozzles', 'spoolSlots'],
  )
  const docs = readFileSync(
    new URL('../../docs/INTEGRATION-API.md', import.meta.url),
    'utf8',
  )
  for (const name of ['specs', 'buildVolumeMm', 'nozzles', 'spoolSlots'])
    assert.ok(docs.includes('`' + name + '`'), name)
})
