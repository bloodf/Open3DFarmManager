import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { expect, it } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import type {
  FarmObservation,
  FarmRow,
} from '../../apps/farm/app/utils/farm-view.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { withBrowser } from '../helpers/browser.ts'
import { vueSfcPlugin } from '../e2e/vue-sfc-plugin.ts'

const now = { wall: Date.UTC(2026, 10, 19, 12), mono: 3000 }
const colors = ['FF4400', '00AA55']
const materialTypes = ['PETG-HF', 'PLA-SEDA']

function observation(historical: boolean): FarmObservation {
  return {
    state: {
      printerKey: '1',
      state: 'printing',
      observedAt: now.wall - 2000,
      progress: 0.4,
      materials: [
        {
          slot: 'ams:0:0',
          active: true,
          colorHex: colors[0],
          materialType: materialTypes[0],
          remainingPercent: 77,
        },
        {
          slot: 'ams:0:1',
          colorHex: colors[1],
          materialType: materialTypes[1],
          remainingPercent: 31,
        },
      ],
    },
    received: { wall: now.wall - 2000, mono: 1000 },
    historical,
    sourceClockComparable: true,
  } as FarmObservation
}

function row(historical: boolean): FarmRow {
  return {
    assignment: {
      assignmentId: '00000000-0000-4000-8000-000000000001',
      agentId: '00000000-0000-4000-8000-000000000009',
      printerKey: 'Impressora 1',
      displayName: 'Impressora 1',
      groupName: 'Produção',
      location: 'Sala 1',
      sortOrder: null,
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: historical ? 'closed' : 'authenticated',
    observation: observation(historical),
    localOrigin: null,
  } as FarmRow
}

function expectNoMaterials(html: string) {
  for (const value of [...materialTypes, ...colors, '77%', '31%']) {
    expect(html).not.toContain(value)
  }
  expect(html).not.toContain('Slots de filamento')
  expect(html).not.toContain('Em uso')
}

function expectMaterials(html: string) {
  for (const value of materialTypes) expect(html).toContain(value)
}

const wallCardProps = (historical: boolean) => ({
  name: 'Impressora 1',
  detailHref: '/impressoras/1',
  now,
  observation: observation(historical),
})

const printerCardProps = (historical: boolean) => ({
  row: row(historical),
  farmId: 'farm-1',
  cameraFor: () => null,
  liveNow: () => now,
})

it('hides last-known materials on the wall card when the observation is historical', async () => {
  const html = await renderFarmComponent(
    'PrinterWallCard.vue',
    wallCardProps(true),
  )
  expectNoMaterials(html)
  expect(html).toContain('Atualização recebida há')
})

it('keeps live materials on the wall card', async () => {
  const html = await renderFarmComponent(
    'PrinterWallCard.vue',
    wallCardProps(false),
  )
  expectMaterials(html)
  expect(html).toContain('Slots de filamento')
})

it('hides last-known materials on the printer card when the observation is historical', async () => {
  const html = await renderFarmComponent(
    'FarmPrinterCard.vue',
    printerCardProps(true),
  )
  expectNoMaterials(html)
  expect(html).toContain('Dados desatualizados')
})

it('keeps live materials on the printer card', async () => {
  const html = await renderFarmComponent(
    'FarmPrinterCard.vue',
    printerCardProps(false),
  )
  expect(html).toContain('Materiais')
  expect(html).toContain('PETG-HF')
})

async function tableCells(historical: boolean) {
  const filename = 'apps/farm/app/components/farm/PrinterWallTable.vue'
  const { descriptor, errors } = parse(await readFile(filename, 'utf8'), {
    filename,
  })
  expect(errors).toEqual([])
  const script = compileScript(descriptor, {
    id: 'printer-wall-table',
    inlineTemplate: true,
    genDefaultAs: 'Wall',
  })
  const bundle = await build({
    plugins: [vueSfcPlugin],
    stdin: {
      contents: `
        ${script.content}
        import { createApp, h } from 'vue'
        const rows = [${JSON.stringify(row(historical))}]
        const now = ${JSON.stringify(now)}
        createApp({
          render: () => h(Wall, { rows, liveNow: () => now }, { default: () => null }),
        }).mount('#app')
      `,
      resolveDir: new URL(
        '../../apps/farm/app/components/farm/',
        import.meta.url,
      ).pathname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
  })
  const outputFile = bundle.outputFiles?.[0]
  if (!outputFile) throw new Error('esbuild produced no output file')
  const server = await startHttpMock({
    port: 0,
    routes: {
      '/'(_request, response) {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(
          '<!doctype html><html lang="pt-BR"><title>Frota</title><main><h1>Frota</h1><div id="app"></div></main><script src="/wall.js"></script></html>',
        )
      },
      '/wall.js'(_request, response) {
        response.setHeader('content-type', 'text/javascript')
        response.end(outputFile.text)
      },
    },
  })
  try {
    return await withBrowser(
      { args: ['--disable-background-networking'] },
      async (browser) => {
        const context = await browser.newContext()
        await context.addInitScript(() =>
          localStorage.setItem('openfarm:printer-wall-view', 'table'),
        )
        const page = await context.newPage()
        await page.goto(server.origin)
        const table = page.getByRole('table')
        await table.waitFor()
        const headers = await table.getByRole('columnheader').allTextContents()
        const cells = await table
          .getByRole('row')
          .nth(1)
          .locator('th, td')
          .allTextContents()
        return Object.fromEntries(
          headers.map((header, index) => [
            header.replace(/[↑↓]/g, '').trim(),
            cells[index]?.trim(),
          ]),
        )
      },
    )
  } finally {
    await server.close()
  }
}

it('hides last-known materials in the table when the observation is historical', async () => {
  const cells = await tableCells(true)
  expect(cells['Materiais']).toBe('Indisponível')
  expect(cells['Alertas']).toContain('Dados desatualizados')
})

it('keeps live materials in the table', async () => {
  const cells = await tableCells(false)
  expect(cells['Materiais']).toBe('PETG-HF, PLA-SEDA')
})
