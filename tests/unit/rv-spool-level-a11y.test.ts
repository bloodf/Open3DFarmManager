import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

const directory = resolve('apps/farm/app/components')
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

import { renderFarmComponent } from '../helpers/render-farm-component.ts'
import { spoolRemainingFraction } from '../../apps/farm/app/utils/spool-library-format.ts'
import { farmSlotViews } from '../../apps/farm/app/utils/slot-spools.ts'

describe('review regressions', () => {
  it('keeps negative Spoolman weight unknown and prefers its percentage', () => {
    expect(
      spoolRemainingFraction({
        remaining_weight: -1,
        initial_weight: 1000,
        filament: { weight: 1000 },
      } as never),
    ).toBeNull()
    const slots = farmSlotViews(
      [{ slot: 'external', remainingPercent: 80 }] as never,
      undefined,
      [{ slot: 'external', remainingPercent: 25 }] as never,
    )
    expect(slots?.[0]?.level).toEqual({
      kind: 'known',
      fraction: 0.25,
      source: 'spoolman',
    })
  })
  it('does not announce a level for an empty slot and announces one meter for a filled slot', async () => {
    const empty = await render('spool-art/FarmSlot', { label: 'Slot 1' })
    expect(empty).toContain('Slot vazio')
    expect(empty).not.toContain('Nível restante')
    const filled = await render('spool-art/FarmSlot', {
      label: 'Slot 1',
      material: 'PLA',
      printerPercent: 50,
    })
    expect(filled).not.toContain('Nível restante')
    expect(filled.match(/role="meter"/g)).toHaveLength(1)
  })

  it('hides stale non-historical materials on the wall card', async () => {
    const now = { wall: 1_000_000, mono: 1_000_000 }
    const html = await renderFarmComponent('PrinterWallCard.vue', {
      name: 'Impressora',
      detailHref: '/impressoras/1',
      now,
      observation: {
        state: {
          printerKey: '1',
          state: 'idle',
          observedAt: 1,
          materials: [
            { slot: 'external', materialType: 'PLA', remainingPercent: 50 },
          ],
        },
        received: { wall: 1, mono: 1 },
        historical: false,
        sourceClockComparable: true,
      },
    })
    expect(html).not.toContain('farm-spool')
    expect(html).toContain('Materiais indisponíveis')
  })
  it('accepts a pasted UUID with surrounding spaces', async () => {
    const html = await render('spoolman/SpoolmanForm', {
      origin: '',
      serviceId: '',
      token: '',
      username: '',
      password: '',
      busy: false,
      connectorCount: 1,
    })
    expect(html).toContain('maxlength="256"')
  })
})
