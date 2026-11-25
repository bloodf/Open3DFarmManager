import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'

const root = resolve('apps/farm')
const sfc = createRequire(join(root, 'package.json'))('vue/compiler-sfc')
const vuePlugin: Plugin = {
  name: 'vue-sfc',
  setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
      const { descriptor, errors } = sfc.parse(readFileSync(path, 'utf8'), {
        filename: path,
      })
      if (errors.length) throw errors[0]
      let contents = sfc.compileScript(descriptor, {
        id: path,
        inlineTemplate: true,
      }).content
      // SSR does not run onMounted, so render the table's real branch directly.
      if (path.endsWith('/PrinterWallTable.vue')) {
        contents = contents.replace(
          "const mode = ref('cards')",
          "const mode = ref('table')",
        )
      }
      return { contents, loader: 'ts', resolveDir: join(path, '..') }
    })
  },
}

const assignment = (assignmentId: string, printerKey: string) => ({
  assignmentId,
  agentId: '00000000-0000-4000-8000-000000000011',
  printerKey,
  displayName: printerKey,
  groupName: null,
  location: null,
  sortOrder: null,
  status: 'active',
  connectorStatus: 'approved',
})
const material = {
  slot: 'ams:0:0',
  materialType: 'PLA-TESTE',
  colorHex: 'AABBCCFF',
  remainingPercent: 42,
  active: true,
}
const row = (historical: boolean, suffix: string) => ({
  assignment: assignment(
    `00000000-0000-4000-8000-0000000000${suffix}`,
    `Printer-${suffix}`,
  ),
  connection: historical ? 'closed' : 'authenticated',
  localOrigin: null,
  observation: {
    historical,
    received: { wall: 1_000, mono: 1_000 },
    sourceClockComparable: true,
    state: {
      state: 'printing',
      progress: 0.5,
      observedAt: 1_000,
      materials: [material],
    },
  },
})

let scratch = ''
let render: () => Promise<string>

beforeAll(async () => {
  const entry = `
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import FarmPrinterCard from '${join(root, 'app/components/farm/FarmPrinterCard.vue')}'
import PrinterWallCard from '${join(root, 'app/components/farm/PrinterWallCard.vue')}'
import PrinterWallTable from '${join(root, 'app/components/farm/PrinterWallTable.vue')}'
const rows = ${JSON.stringify([row(true, '001'), row(false, '002'), row(false, '003')])}
rows[2].observation.received = { wall: -999999, mono: -999999 }
rows[2].observation.state.observedAt = -999999
const now = { wall: 1000, mono: 1000 }
export async function render() {
  return renderToString(createSSRApp({ render: () => h('main', [
    ...rows.map((row, index) => h('section', { 'data-view': 'farm-' + index }, [
      h(FarmPrinterCard, { row, farmId: 'farm', cameraFor: () => null, liveNow: () => now }),
    ])),
    ...rows.map((row, index) => h('section', { 'data-view': 'wall-' + index }, [
      h(PrinterWallCard, { name: row.assignment.printerKey, detailHref: '#', observation: row.observation, now }),
    ])),
    h('section', { 'data-view': 'table' }, [h(PrinterWallTable, { rows, liveNow: () => now })]),
  ]) }))
}`
  const bundle = await build({
    stdin: { contents: entry, loader: 'ts', resolveDir: root },
    plugins: [vuePlugin],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    nodePaths: [join(root, '../../node_modules')],
    logLevel: 'silent',
  })
  scratch = mkdtempSync(join(tmpdir(), 'stale-materials-'))
  const output = bundle.outputFiles[0]
  if (!output) throw new Error('esbuild produced no application bundle')
  const bundleFile = join(scratch, 'bundle.cjs')
  writeFileSync(bundleFile, output.text)
  render = createRequire(bundleFile)(bundleFile).render
})

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

it('hides historical material data in all three views and keeps live data', async () => {
  const html = await render()
  const view = (name: string) =>
    html.split(`data-view="${name}"`)[1]?.split('</section>')[0] ?? ''
  expect(view('farm-0')).not.toContain('PLA-TESTE')
  expect(view('farm-1')).toContain('PLA-TESTE')
  expect(view('wall-0')).not.toContain('PLA-TESTE')
  expect(view('wall-1')).toContain('PLA-TESTE')
  expect(view('farm-2')).not.toContain('PLA-TESTE')
  expect(view('wall-2')).not.toContain('PLA-TESTE')
  const table = view('table')
  expect(table).toContain('Materiais')
  const rowCells = (printer: string) => {
    const rowHtml = table.match(
      new RegExp(
        `<tr><th scope="row"><a[^>]*>${printer}<\\/a><\\/th>(.*?)<\\/tr>`,
      ),
    )?.[1]
    return [...(rowHtml ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(
      (cell) => cell[1],
    )
  }
  expect(rowCells('Printer-001')[8]).toBe('Indisponível')
  expect(rowCells('Printer-002')[8]).toBe('PLA-TESTE')
  expect(rowCells('Printer-003')[8]).toBe('Indisponível')
})
