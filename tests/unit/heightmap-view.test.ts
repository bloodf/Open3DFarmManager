// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import {
  DEFAULT_VIEW,
  drawHeightmap,
  meshColor,
  meshRequest,
  meshRowsFor,
  meshStats,
  meshSummary,
  meshTable,
  projectMesh,
  rotateView,
  SCALE_STOPS,
  type BedMeshData,
  type HeightmapContext,
  type MeshRows,
} from '../../apps/farm/app/components/printer-detail/heightmap-view.ts'
import { ControlArguments } from '../../packages/farm-protocol/src/control-actions.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { launchBrowser } from '../helpers/browser.ts'

/** A bowl-shaped square mesh: lowest in the middle, 0.3 mm higher at the corners. */
const bowl = (n: number): MeshRows =>
  Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, column) => {
      const x = column / (n - 1) - 0.5
      const y = row / (n - 1) - 0.5
      return Number((-0.1 + 1.2 * (x * x + y * y)).toFixed(4))
    }),
  )
const meshOf = (n: number, extra: Partial<BedMeshData> = {}): BedMeshData => ({
  profile: 'default',
  min: [10, 10],
  max: [210, 210],
  rows: bowl(n),
  ...extra,
})
const size = { width: 480, height: 360 }

/** In-process stand-in for a 2D canvas context: it records what was drawn. */
function recordingContext() {
  const calls = { fills: [] as string[], strokes: 0, cleared: 0, paths: 0 }
  let fillStyle = ''
  const context = {
    clearRect: () => calls.cleared++,
    beginPath: () => calls.paths++,
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: () => calls.fills.push(fillStyle),
    stroke: () => calls.strokes++,
    set fillStyle(value: string) {
      fillStyle = value
    },
    get fillStyle() {
      return fillStyle
    },
    strokeStyle: '',
    lineWidth: 0,
  }
  return { context: context as unknown as HeightmapContext, calls }
}

describe('mesh statistics and colour scale', () => {
  it('reports minimum, maximum and range, ignoring non-finite points', () => {
    expect(
      meshStats([
        [0.1, -0.2],
        [Number.NaN, 0.3],
      ]),
    ).toEqual({ min: -0.2, max: 0.3, range: 0.5, columns: 2, rows: 2 })
    expect(meshStats([])).toBeUndefined()
    expect(meshStats([[Number.NaN]])).toBeUndefined()
  })
  it('maps the ends of the range to the ends of the scale and clamps', () => {
    expect(meshColor(0, 0, 1)).toBe(SCALE_STOPS[0])
    expect(meshColor(1, 0, 1)).toBe(SCALE_STOPS.at(-1))
    expect(meshColor(-5, 0, 1)).toBe(SCALE_STOPS[0])
    expect(meshColor(5, 0, 1)).toBe(SCALE_STOPS.at(-1))
    expect(meshColor(0.5, 0, 1)).toBe(SCALE_STOPS[2])
    expect(meshColor(0.3, 0.3, 0.3)).toBe(SCALE_STOPS[2])
  })
  it('chooses probed or interpolated points, falling back when none were probed', () => {
    const probed = bowl(3)
    const mesh = meshOf(5, { probed })
    expect(meshRowsFor(mesh, 'probed')).toBe(probed)
    expect(meshRowsFor(mesh, 'interpolated')).toBe(mesh.rows)
    expect(meshRowsFor(meshOf(5), 'probed')).toHaveLength(5)
    expect(meshRowsFor(undefined, 'probed')).toEqual([])
  })
  it('summarises in pt-BR', () => {
    expect(meshSummary(bowl(7), 'probed', 'default')).toBe(
      'Malha sondada de 7 por 7 pontos, perfil default. Mínimo -0,100 mm, máximo 0,500 mm, variação 0,600 mm.',
    )
    expect(meshSummary([], 'interpolated', null)).toBe(
      'Sem malha de mesa disponível.',
    )
  })
})

describe('heightmap projection and drawing', () => {
  it.each([7, 25])('draws every cell of a %i×%i mesh, far to near', (n) => {
    const quads = projectMesh(bowl(n), meshOf(n), DEFAULT_VIEW, size)
    expect(quads).toHaveLength((n - 1) ** 2)
    for (let i = 1; i < quads.length; i++)
      expect(quads[i - 1]!.depth).toBeGreaterThanOrEqual(quads[i]!.depth)
    for (const quad of quads)
      for (const [x, y] of quad.points) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(size.width)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(size.height)
      }
    const { context, calls } = recordingContext()
    expect(drawHeightmap(context, quads, size)).toBe((n - 1) ** 2)
    expect(calls).toMatchObject({
      cleared: 1,
      paths: (n - 1) ** 2,
      strokes: (n - 1) ** 2,
    })
    // The bowl has a low centre and high corners, so more than one colour shows.
    expect(new Set(calls.fills).size).toBeGreaterThan(3)
  })
  it('turns with the view: the picture differs for another yaw and pitch', () => {
    const first = projectMesh(bowl(7), meshOf(7), DEFAULT_VIEW, size)
    const turned = projectMesh(
      bowl(7),
      meshOf(7),
      rotateView(DEFAULT_VIEW, 90, 20),
      size,
    )
    expect(turned[0]!.points).not.toEqual(first[0]!.points)
  })
  it('shows a top view as a flat picture and an exaggerated side view', () => {
    const top = projectMesh(bowl(7), meshOf(7), { yaw: 0, pitch: 90 }, size)
    const ys = top.flatMap(({ points }) => points.map(([, y]) => y))
    const xs = top.flatMap(({ points }) => points.map(([x]) => x))
    // A square bed seen from above stays square.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(
      Math.max(...ys) - Math.min(...ys),
      6,
    )
  })
  it('draws a flat mesh in the middle colour and nothing for an unusable one', () => {
    const flat = Array.from({ length: 4 }, () => [0.1, 0.1, 0.1, 0.1])
    const { context, calls } = recordingContext()
    drawHeightmap(
      context,
      projectMesh(flat, meshOf(4), DEFAULT_VIEW, size),
      size,
    )
    expect(new Set(calls.fills)).toEqual(new Set([SCALE_STOPS[2]]))
    expect(projectMesh([[0.1, 0.2]], meshOf(2), DEFAULT_VIEW, size)).toEqual([])
    expect(projectMesh([], meshOf(2), DEFAULT_VIEW, size)).toEqual([])
    // A cell with a missing point is skipped rather than guessed.
    expect(
      projectMesh(
        [
          [0, 0],
          [0, Number.NaN],
        ],
        meshOf(2),
        DEFAULT_VIEW,
        size,
      ),
    ).toEqual([])
  })
  it('keeps the pitch between side and top view and wraps the yaw', () => {
    expect(rotateView({ yaw: 170, pitch: 85 }, 30, 30)).toEqual({
      yaw: -160,
      pitch: 90,
    })
    expect(rotateView({ yaw: -170, pitch: 10 }, -30, -30)).toEqual({
      yaw: 160,
      pitch: 5,
    })
  })
})

describe('mesh table model', () => {
  it('labels columns by X and rows by Y across the mesh bounds', () => {
    const table = meshTable(
      [
        [0, 0.1, 0.2],
        [0.3, 0.4, 0.5],
      ],
      { min: [0, 10], max: [100, 20] },
    )!
    expect(table.columns).toEqual(['0,0', '50,0', '100,0'])
    expect(table.rows.map(({ label }) => label)).toEqual(['10,0', '20,0'])
    expect(table.rows[1]!.cells[2]).toMatchObject({ text: '0,500', value: 0.5 })
    expect(meshTable([], { min: [0, 0], max: [1, 1] })).toBeUndefined()
  })
})

describe('mesh command request', () => {
  it('builds arguments the signed protocol accepts', () => {
    for (const [op, name] of [
      ['calibrate', ''],
      ['calibrate', 'cold'],
      ['save', 'cold'],
      ['load', 'cold'],
      ['remove', 'cold'],
      ['clear', 'ignored'],
    ] as const) {
      const request = meshRequest(op, name)
      expect('args' in request).toBe(true)
      if ('args' in request)
        expect(
          ControlArguments.safeParse({ action: 'bed_mesh', args: request.args })
            .success,
        ).toBe(true)
    }
    expect(meshRequest('clear', 'ignored')).toEqual({ args: { op: 'clear' } })
  })
  it('explains in pt-BR when the profile name is missing or unusable', () => {
    expect(meshRequest('save', ' ')).toEqual({
      note: 'Informe o nome do perfil.',
    })
    expect(meshRequest('load', '')).toHaveProperty('note')
    expect(meshRequest('calibrate', 'com espaço')).toEqual({
      note: 'Use de 1 a 32 letras sem acento, números ou sublinhado no nome do perfil.',
    })
    expect(meshRequest('calibrate', 'a'.repeat(33))).toHaveProperty('note')
  })
})

const file = '../printer-detail/BedMeshPanel.vue'
const allOn = Object.fromEntries(
  ['calibrate', 'load', 'save', 'remove', 'clear'].map((op) => [
    op,
    { available: true },
  ]),
)
const allOff = (reason: string) =>
  Object.fromEntries(
    Object.keys(allOn).map((op) => [op, { available: false, reason }]),
  )

describe('BedMeshPanel', () => {
  const base = {
    mesh: meshOf(7, { probed: bowl(3), profiles: ['default', 'cold'] }),
    availability: allOn,
  }
  it('shows the readout, canvas, colour legend, flat grid, table and profile controls', async () => {
    const html = await renderFarmComponent(file, base)
    for (const text of [
      'Malha da mesa',
      'Mínimo: -0,100 mm',
      'Máximo: 0,500 mm',
      'Variação: 0,600 mm',
      'Interpolados',
      'Sondados',
      'Mapa de altura tridimensional da malha da mesa',
      'Girar para a esquerda',
      'Escala de cores',
      'Grade de cores (vista de cima)',
      'Tabela de alturas da malha',
      'Calibrar malha',
      'Salvar perfil',
      'Limpar malha ativa',
      'Carregar perfil',
      'Remover perfil',
    ])
      expect(html).toContain(text)
    expect(html).toContain('<canvas')
    // 7×7 data rows plus the header row.
    expect(html.match(/<tr/g)).toHaveLength(8)
    expect(html).not.toContain('disabled=""')
  })
  it('renders a 25×25 mesh as a 25×25 table and grid', async () => {
    const html = await renderFarmComponent(file, { ...base, mesh: meshOf(25) })
    expect(html.match(/<tr/g)).toHaveLength(26)
    expect(html.match(/<td/g)).toHaveLength(625)
    expect(html).toContain('A impressora não informou os pontos sondados.')
  })
  it('says why commands are off, once, and disables every operation', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      availability: allOff(
        'Comando indisponível. A impressora está imprimindo.',
      ),
    })
    expect(html.match(/A impressora está imprimindo\./g)).toHaveLength(1)
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(5)
  })
  it('keeps the controls when no mesh was reported yet', async () => {
    const html = await renderFarmComponent(file, { availability: allOn })
    expect(html).toContain('Sem malha de mesa disponível.')
    expect(html).toContain('Calibrar malha')
    expect(html).not.toContain('<canvas')
    expect(html).not.toContain('Carregar perfil')
  })
})

describe('BedMeshPanel accessibility', () => {
  it('passes axe, fits and keeps the table reachable at 320, 768 and 1280 px', async () => {
    const read = (path: string) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    const styles = async (paths: string[]) =>
      (
        await Promise.all(
          paths.map(async (path) =>
            parse(await read(path)).descriptor.styles.map((s) => s.content),
          ),
        )
      )
        .flat()
        .join('\n')
    const css = `${await read('../../apps/farm/app/assets/tokens/tokens.css')}
${(await read('../../apps/farm/app/assets/css/main.css')).replace(/^@import .*;$/m, '')}\n${await styles(
      [
        '../../apps/farm/app/components/printer-detail/BedMeshPanel.vue',
        '../../apps/farm/app/components/ui/Button.vue',
      ],
    )}`
    const pages = {
      '/7': await renderFarmComponent(file, {
        mesh: meshOf(7, { probed: bowl(3), profiles: ['default'] }),
        availability: allOn,
      }),
      '/25': await renderFarmComponent(file, {
        mesh: meshOf(25),
        availability: allOff('Comando indisponível.'),
      }),
    }
    const server = await startHttpMock({
      port: 0,
      routes: Object.fromEntries(
        Object.entries(pages).map(([route, html]) => [
          route,
          (_req: unknown, res: { setHeader: Function; end: Function }) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(
              `<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Malha</title><style>${css}</style><main><h1>Impressora</h1>${html}</main></html>`,
            )
          },
        ]),
      ),
    })
    try {
      const browser = await launchBrowser({
        args: ['--disable-background-networking'],
      })
      try {
        const page = await (await browser.newContext()).newPage()
        await page.route('**/*', (route) =>
          new URL(route.request().url()).origin === server.origin
            ? route.continue()
            : route.abort(),
        )
        for (const route of Object.keys(pages))
          for (const width of [320, 768, 1280]) {
            await page.setViewportSize({ width, height: 900 })
            expect((await page.goto(server.origin + route))?.ok()).toBe(true)
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth),
            ).toBe(width)
            expect(
              (await new AxeBuilder({ page }).analyze()).violations,
            ).toEqual([])
            // The table region takes focus, so a wide mesh scrolls by keyboard.
            await page
              .getByRole('region', { name: 'Tabela de alturas da malha' })
              .focus()
            expect(
              await page.evaluate(() =>
                document.activeElement?.getAttribute('aria-label'),
              ),
            ).toBe('Tabela de alturas da malha')
          }
      } finally {
        await browser.close()
      }
    } finally {
      await server.close()
    }
  }, 60_000)
})
