import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

const directory = resolve('apps/farm/app/components/ui/charts')
const require = createRequire(import.meta.url)

async function render(name: string, props: Record<string, unknown>) {
  const filename = resolve(directory, `${name}.vue`)
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), {
    filename,
  })
  if (errors.length) throw errors[0]
  const script = compileScript(descriptor, { id: name, inlineTemplate: true })
  const { outputFiles } = await build({
    stdin: { contents: script.content, loader: 'ts', resolveDir: directory },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vue'],
    write: false,
  })
  const module: { exports: { default?: Component } } = { exports: {} }
  new Function('require', 'module', outputFiles[0]!.text)(require, module)
  return renderToString(createSSRApp(module.exports.default!, props))
}

const start = Date.UTC(2026, 0, 1)
const point = { time: start, value: 42 }

describe.each(['LineChart', 'Sparkline'])('%s', (name) => {
  function renderPoints(points: { time: number; value: number }[]) {
    return render(name, {
      label: 'Temperatura',
      ...(name === 'LineChart'
        ? { series: [{ label: 'Mesa', color: 'green', points }] }
        : { points }),
    })
  }

  it('announces empty data', async () => {
    const html = await renderPoints([])
    expect(html).toMatch(/sem dados/i)
    expect(html).not.toMatch(/<(circle|polyline)\b/)
  })

  it('renders a single point with finite coordinates', async () => {
    const html = await renderPoints([point])
    expect(html).toMatch(/<circle cx="[\d.]+" cy="[\d.]+"/)
  })

  it('renders every point in a 600-point series', async () => {
    const html = await renderPoints(
      Array.from({ length: 600 }, (_, i) => ({
        time: start + i * 1000,
        value: i,
      })),
    )
    const coordinates = html
      .match(/<polyline points="([^"]+)"/)?.[1]
      ?.split(' ')
    expect(coordinates).toHaveLength(600)
    expect(
      coordinates?.every((pair) =>
        pair.split(',').every((n) => Number.isFinite(Number(n))),
      ),
    ).toBe(true)
  })
})

it('exposes a native keyboard control, target and table for multiple series', async () => {
  const html = await render('LineChart', {
    label: 'Temperatura',
    unit: '°C',
    series: [
      { label: 'Mesa', color: 'green', points: [point] },
      {
        label: 'Bico',
        color: 'blue',
        points: [
          { ...point, value: 84 },
          { time: start + 1000, value: 86 },
        ],
      },
    ],
    targets: [{ label: 'Aquecimento', value: 90 }],
  })
  expect(html).toMatch(
    /<label[^>]*>\s*Explorar por horário\s*<input type="range"[^>]*max="1"/,
  )
  expect(html).toMatch(/aria-valuetext="[^"]*Mesa: 42 °C · Bico: 84 °C"/)
  expect(html).toContain('Aquecimento (90 °C)')
  expect(html).toContain('stroke-dasharray="5 4"')
  expect(html).toContain('<th scope="col">Horário (UTC)</th>')
  expect(html).toContain('<td>Sem dado</td>')
})

it('clamps progress to the accessible range', async () => {
  const html = await render('ProgressRing', { label: 'Impressão', value: 120 })
  expect(html).toContain(
    'role="progressbar" aria-label="Impressão" aria-valuenow="100"',
  )
  expect(html).toContain('stroke-dasharray="100 100"')
})

it('labels color bands in their supplied order', async () => {
  const html = await render('ColorScaleLegend', {
    label: 'Temperatura',
    stops: [
      { label: 'Até 30 °C', color: 'blue' },
      { label: 'Acima de 30 °C', color: 'red' },
    ],
  })
  expect(html).toMatch(
    /<ol[^>]*>.*fill="blue".*Até 30 °C.*fill="red".*Acima de 30 °C.*<\/ol>/,
  )
})
