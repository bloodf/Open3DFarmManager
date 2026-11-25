import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

const directory = resolve('apps/farm/app/components/spool-art')
const require = createRequire(import.meta.url)

// Compiles a single-file component (script and template only) and renders it
// on the server, resolving sibling .vue imports the same way.
async function render(name: string, props: Record<string, unknown>) {
  const { outputFiles } = await build({
    stdin: {
      contents: `export { default } from './${name}.vue'`,
      resolveDir: directory,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vue'],
    write: false,
    plugins: [
      {
        name: 'sfc',
        setup(b) {
          b.onLoad({ filter: /\.vue$/ }, ({ path }) => {
            const { descriptor, errors } = parse(readFileSync(path, 'utf8'), {
              filename: path,
            })
            if (errors.length) throw errors[0]
            const script = compileScript(descriptor, {
              id: path,
              inlineTemplate: true,
            })
            return {
              contents: script.content,
              loader: 'ts',
              resolveDir: dirname(path),
            }
          })
        },
      },
    ],
  })
  const module: { exports: { default?: Component } } = { exports: {} }
  new Function('require', 'module', outputFiles[0]!.text)(require, module)
  return renderToString(createSSRApp(module.exports.default!, props))
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('FarmSpool', () => {
  it('draws the reel at a known level, painted with the filament colour', async () => {
    const html = await render('FarmSpool', { color: '#c0392b', fraction: 0.7 })
    expect(html).toContain('data-level="3"')
    expect(html).toContain('/spool-art/n3-corpo.webp')
    expect(html).toContain('/spool-art/n3-fio.webp')
    expect(html).toContain('--farm-spool-paint:#c0392b')
    expect(html).not.toContain('data-unknown')
    expect(html).not.toContain('desconhecido')
    expect(html).toContain('data-color="set"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('draws the bare reel when the spool is empty, with no winding layer', async () => {
    const html = await render('FarmSpool', { color: '#c0392b', fraction: 0 })
    expect(html).toContain('data-level="8"')
    expect(html).toContain('/spool-art/n8-corpo.webp')
    expect(html).not.toContain('-fio.webp')
    expect(html).not.toContain('desconhecido')
  })

  it('keeps any filament left above the bare reel', async () => {
    const html = await render('FarmSpool', { color: 'red', fraction: 0.01 })
    expect(html).toContain('data-level="7"')
  })

  it('draws the full reel with a visible desconhecido badge when the level is unknown', async () => {
    for (const fraction of [null, undefined, Number.NaN]) {
      const html = await render('FarmSpool', { color: '#2e86c1', fraction })
      expect(html).toContain('data-level="1"')
      expect(html).toContain('data-unknown="true"')
      expect(text(html)).toBe('desconhecido')
      // The badge is not hidden from assistive technology.
      expect(html).toMatch(
        /<span class="farm-spool-unknown">desconhecido<\/span>/,
      )
    }
  })

  it('paints a missing colour with a neutral token, never a guessed colour', async () => {
    for (const color of [null, undefined, '']) {
      const html = await render('FarmSpool', { color, fraction: 0.5 })
      expect(html).toContain('data-color="missing"')
      expect(html).toContain('--farm-spool-paint:var(--ops-idle)')
      expect(html).not.toMatch(/#[\da-f]{3,8}/i)
    }
    const unknownAndColourless = await render('FarmSpool', {})
    expect(unknownAndColourless).toContain('data-level="1"')
    expect(unknownAndColourless).toContain('desconhecido')
    expect(unknownAndColourless).toContain('var(--ops-idle)')
  })

  it('paints a multi-colour filament as a gradient', async () => {
    const html = await render('FarmSpool', {
      colors: ['#111111', '#eeeeee'],
      fraction: 1,
    })
    expect(html).toContain('linear-gradient(90deg')
    const coaxial = await render('FarmSpool', {
      colors: ['#111111', '#eeeeee'],
      direction: 'coaxial',
      fraction: 1,
    })
    expect(coaxial).toContain('conic-gradient')
  })
})

describe('FarmLevel', () => {
  it('exposes the value to assistive technology', async () => {
    const html = await render('FarmLevel', {
      fraction: 0.25,
      label: 'Filamento restante',
    })
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-label="Filamento restante"')
    expect(html).toContain('aria-valuenow="25"')
    expect(html).toContain('width:25%')
    expect(html).not.toContain('data-unknown')
  })

  it('shows an unknown amount as a hatched track without a value', async () => {
    const html = await render('FarmLevel', { label: 'Filamento restante' })
    expect(html).toContain('data-unknown="true"')
    expect(html).not.toContain('aria-valuenow')
    expect(html).not.toContain('role="meter"')
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Filamento restante: desconhecido"')
  })

  it('shows an empty spool as a known zero, not as unknown', async () => {
    const html = await render('FarmLevel', { fraction: 0, label: 'Resto' })
    expect(html).toContain('aria-valuenow="0"')
    expect(html).not.toContain('data-unknown')
  })
})

describe('FarmSlot', () => {
  const base = { label: 'AMS 1 · A2', material: 'PLA', name: 'PLA Preto' }

  it('shows the Spoolman weights and a known level', async () => {
    const html = await render('FarmSlot', {
      ...base,
      color: '#202020',
      colorName: 'Preto',
      spoolmanRemainingWeight: 250,
      spoolmanInitialWeight: 1000,
      printerPercent: 90,
    })
    expect(html).toContain('data-level-source="spoolman"')
    expect(html).toContain('data-level="6"')
    const t = text(html)
    expect(t).toContain('PLA Preto')
    expect(t).toContain('PLA · Preto')
    expect(t).toMatch(/250\s?g de 1\.000\s?g/)
    expect(t).toContain('25')
    expect(html).toContain('aria-valuenow="25"')
    expect(html).not.toContain('desconhecido')
  })

  it('falls back to the printer percentage and says where it came from', async () => {
    const html = await render('FarmSlot', {
      ...base,
      color: '#202020',
      printerPercent: 40,
    })
    expect(html).toContain('data-level-source="printer"')
    expect(text(html)).toContain('informado pela impressora')
    expect(html).toContain('aria-valuenow="40"')
  })

  it('renders an empty slot without inventing a level', async () => {
    const html = await render('FarmSlot', { label: 'AMS 1 · A3' })
    expect(html).toContain('data-empty="true"')
    expect(html).toContain('data-level="8"')
    expect(text(html)).toContain('Slot vazio')
    expect(html).not.toContain('role="meter"')
    expect(html).not.toContain('farm-slot-strip')
    expect(html).not.toContain('desconhecido')
  })

  it('renders an unknown level with the full reel, the badge and text, not a made-up amount', async () => {
    const html = await render('FarmSlot', {
      ...base,
      color: '#202020',
      printerPercent: 255,
      spoolmanRemainingWeight: -3,
      spoolmanInitialWeight: 1000,
    })
    expect(html).toContain('data-level-source="unknown"')
    expect(html).toContain('data-level="1"')
    expect(html).toContain('data-unknown="true"')
    const t = text(html)
    expect(t).toContain('desconhecido')
    expect(t).toContain('Quantidade desconhecida')
    expect(html).not.toContain('aria-valuenow')
  })

  it('states a missing colour in text and hatches the strip', async () => {
    const html = await render('FarmSlot', {
      ...base,
      printerPercent: 60,
    })
    expect(text(html)).toContain('PLA · Cor não informada')
    expect(html).toContain('data-color="missing"')
    expect(html).toMatch(/farm-slot-strip" data-unknown="true"/)
    expect(html).toContain('--farm-spool-paint:var(--ops-idle)')
    expect(html).not.toMatch(/#[\da-f]{3,8}/i)
  })

  it('keeps the material in text when the name is missing', async () => {
    const html = await render('FarmSlot', {
      label: 'Ferramenta 1',
      material: 'PETG',
      color: '#2e86c1',
      printerPercent: 80,
    })
    expect(text(html)).toContain('PETG')
  })
})
