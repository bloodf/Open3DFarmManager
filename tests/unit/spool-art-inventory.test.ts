import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

const require = createRequire(import.meta.url)
async function render(path: string, props: Record<string, unknown>) {
  const { outputFiles } = await build({
    stdin: {
      contents: `export { default } from ${JSON.stringify(path.startsWith('.') ? path : `./${path}`)}`,
      resolveDir: resolve('.'),
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
          b.onLoad({ filter: /\.vue$/ }, ({ path: file }) => {
            const { descriptor, errors } = parse(readFileSync(file, 'utf8'), {
              filename: file,
            })
            if (errors.length) throw errors[0]
            const script = compileScript(descriptor, {
              id: file,
              inlineTemplate: true,
            })
            return {
              contents: script.content,
              loader: 'ts',
              resolveDir: dirname(file),
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
const spool = {
  id: 1,
  registered: '',
  filament: {
    id: 2,
    registered: '',
    name: 'PLA Azul',
    color_hex: '2463eb',
    weight: 1000,
    density: 1.24,
    diameter: 1.75,
    extra: {},
  },
  used_weight: 0,
  used_length: 0,
  archived: false,
  extra: {},
}
const includesUnknownReel = (html: string) =>
  html.includes('/spool-art/n1-corpo.webp') &&
  html.includes('desconhecido') &&
  html.includes('data-unknown="true"')

describe('drawn spool inventory screens', () => {
  it('renders the library reel with an unknown badge when weight is unavailable', async () => {
    const html = await render(
      'apps/farm/app/components/spool-library/SpoolArt.vue',
      { spool, size: 40 },
    )
    expect(includesUnknownReel(html)).toBe(true)
    expect(html).toContain('--farm-spool-paint:#2463eb')
    expect(html).toContain('farm-spool')
  })
  it('shows a reel and unknown badge in SpoolInventory', async () => {
    const html = await render('apps/farm/app/components/SpoolInventory.vue', {
      items: [
        {
          agentId: 'connector',
          received: { wall: 1, mono: 1 },
          historical: false,
          inventory: {
            observedAt: 1,
            stale: false,
            total: 1,
            spools: [
              {
                name: 'PLA Azul',
                material: 'PLA',
                colorHex: '2463eb',
                remainingGrams: 500,
                location: null,
                archived: false,
              },
            ],
          },
        },
      ],
      now: { wall: 2, mono: 2 },
      connected: true,
      rows: [],
    })
    expect(includesUnknownReel(html)).toBe(true)
    expect(html).toContain('PLA Azul')
  })
})
