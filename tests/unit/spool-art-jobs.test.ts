import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import {
  matchFilament,
  normalizeColour,
} from '../../apps/farm/app/utils/filament-match'

const directory = resolve('apps/farm/app/components/library')
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

const required = { type: 'PLA', colour: '#ff0000' }

describe('filament match result', () => {
  it('compares material and colour without guessing', () => {
    const red = { materialType: 'pla', colorHex: 'FF0000FF' }
    expect(matchFilament(required, red).kind).toBe('match')
    expect(matchFilament(required, { ...red, colorHex: '0000FFFF' }).kind).toBe(
      'colour-differs',
    )
    expect(matchFilament(required, { ...red, materialType: 'PETG' })).toEqual({
      kind: 'material-differs',
      tone: 'warn',
      text: 'Material diferente: o arquivo pede PLA, o slot tem PETG.',
    })
    expect(matchFilament(required, { materialType: 'PLA' }).kind).toBe(
      'colour-unknown',
    )
    expect(matchFilament({ colour: '#ff0000' }, red).kind).toBe(
      'material-unknown',
    )
    expect(matchFilament(required, null).kind).toBe('no-slot')
    expect(normalizeColour('not-a-colour')).toBeUndefined()
  })
})

describe('filament match view', () => {
  it('shows the required reel, the matched slot reel and a match sentence', async () => {
    const html = await render('FilamentMatch', {
      index: 1,
      required,
      matched: {
        label: 'Slot 1',
        materialType: 'PLA',
        colorHex: 'FF0000FF',
        remainingPercent: 60,
      },
    })
    const t = text(html)
    expect(html).toContain('data-kind="match"')
    expect(html.match(/class="farm-spool"/g)).toHaveLength(2)
    expect(t).toContain('Filamento 1 do arquivo PLA #ff0000')
    expect(t).toContain('Slot 1 PLA Cor #ff0000')
    expect(t).toContain('60%, informado pela impressora')
    expect(t).toContain('Combina: material e cor iguais.')
    expect(t).not.toContain('desconhecido')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuenow="60"')
  })

  it('says why a slot does not match, in text beside the colours', async () => {
    const html = await render('FilamentMatch', {
      index: 2,
      required,
      matched: {
        label: 'Slot 3',
        materialType: 'PETG',
        colorHex: '0000FFFF',
        remainingPercent: 60,
        spoolmanRemainingWeight: 250,
        spoolmanInitialWeight: 1000,
      },
    })
    const t = text(html)
    expect(html).toContain('data-kind="material-differs"')
    expect(html).toContain('data-tone="warn"')
    expect(t).toContain(
      'Material diferente: o arquivo pede PLA, o slot tem PETG.',
    )
    expect(t).toContain('Slot 3 PETG Cor #0000ff')
    expect(t).toContain('25%')
    expect(html).not.toContain('data-unknown')
  })

  it('prefers the Spoolman percentage over the printer one when no weights are known', async () => {
    const html = await render('FilamentMatch', {
      index: 1,
      required,
      matched: {
        label: 'Slot 2',
        materialType: 'PLA',
        colorHex: 'FF0000FF',
        remainingPercent: 85,
        spoolmanRemainingPercent: 25,
      },
    })
    const t = text(html)
    expect(html).toContain('aria-valuenow="25"')
    expect(t).toContain('25%, informado pelo Spoolman')
    expect(t).not.toContain('informado pela impressora')
  })

  it('draws the full reel with a "desconhecido" badge when the level is unknown', async () => {
    const html = await render('FilamentMatch', {
      index: 1,
      required,
      matched: {
        label: 'Slot 2',
        materialType: 'PLA',
        colorHex: 'FF0000FF',
        remainingPercent: -1,
      },
    })
    const t = text(html)
    expect(html).toContain('data-kind="match"')
    expect(html).toContain('farm-spool-unknown')
    expect(html).toContain('data-level="1"')
    expect(html).toContain(
      'aria-label="Quantidade restante no Slot 2: desconhecido"',
    )
    expect(t).toContain('Quantidade desconhecida')
    expect(html).not.toContain('role="meter"')
  })

  it('states a missing colour in text and never paints a guessed one', async () => {
    const html = await render('FilamentMatch', {
      index: 1,
      required: { type: 'PLA' },
      matched: { label: 'Slot 1', materialType: 'PLA', remainingPercent: 40 },
    })
    const t = text(html)
    expect(html).toContain('data-color="missing"')
    expect(html).not.toContain('data-color="set"')
    expect(t).toContain('Cor não informada')
    expect(html).toContain('data-kind="colour-unknown"')
  })

  it('shows only the required filament and says so when no slot is chosen', async () => {
    const html = await render('FilamentMatch', { index: 1, required })
    expect(html.match(/class="farm-spool"/g)).toHaveLength(1)
    expect(text(html)).toContain('Nenhum slot escolhido para este filamento.')
  })
})
