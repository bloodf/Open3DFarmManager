import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { expect, test } from 'vitest'
import { controlActionAvailability } from '../../apps/farm/app/utils/farm-control.ts'
import { normalizeMoonrakerSnapshot } from '../../packages/connector/src/moonraker/normalize.ts'

async function component(path: string) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['vue'],
    plugins: [
      {
        name: 'vue',
        setup(builder) {
          builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const { descriptor, errors } = parse(await readFile(path, 'utf8'), {
              filename: path,
            })
            if (errors.length) throw errors[0]
            return {
              contents: compileScript(descriptor, {
                id: 'test',
                inlineTemplate: true,
              }).content,
              loader: 'ts',
              resolveDir: dirname(path),
            }
          })
        },
      },
    ],
  })
  const module = { exports: {} as { default?: any } }
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  )
  return module.exports.default
}

const keys = { kind: 'available', selected: 'key', choices: [] } as const
function row(state = 'idle') {
  return {
    assignment: {
      assignmentId: 'a',
      printerKey: 'p',
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: 'authenticated',
    observation: {
      historical: false,
      received: { wall: Date.now(), mono: performance.now() },
      state: {
        state,
        controls: ['set_temperature', 'set_tool_temperature'],
        toolHeaters: [
          { tool: 0, maxC: 200 },
          { tool: 1, maxC: 250 },
        ],
      },
    },
  } as any
}

test('tool controls identify each tool and expose its temperature limit', async () => {
  const Comp = await component(
    'apps/farm/app/components/FarmExtendedControls.vue',
  )
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(Comp, {
          row: row(),
          keys,
          controlEnabled: true,
          commandInFlight: false,
          now: { wall: Date.now(), mono: performance.now() },
        }),
    }),
  )
  expect(html).toContain('Ferramenta 1 — Temperatura em °C')
  expect(html).toContain('Ferramenta 2 — Temperatura em °C')
  expect(html).toContain('Definir temperatura da Ferramenta 1')
  expect(html).toContain('Definir temperatura da Ferramenta 2')
  expect(html).toContain('max="200"')
  expect(html).toContain('max="250"')
})

test('confirmation identifies the selected tool and target', async () => {
  const Comp = await component(
    'apps/farm/app/components/farm/ToolTemperatureConfirmation.vue',
  )
  const html = await renderToString(
    createSSRApp({ render: () => h(Comp, { tool: 1, targetC: 215 }) }),
  )
  expect(html).toContain('215 °C para a Ferramenta 2')
})

test('extended command pending status uses its own wording', async () => {
  const Comp = await component(
    'apps/farm/app/components/farm/ExtendedControlStatus.vue',
  )
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(Comp, { state: { kind: 'sending' }, remaining: 0, lost: false }),
    }),
  )
  expect(html).toContain('Enviando o comando…')
})

test('extended command result shows the Connector refusal reason', async () => {
  const Comp = await component(
    'apps/farm/app/components/farm/ExtendedControlStatus.vue',
  )
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(Comp, {
          state: {
            kind: 'settled',
            outcome: 'not-sent',
            code: 'tool-temperature-above-maximum',
          },
          remaining: 0,
          lost: false,
        }),
    }),
  )
  expect(html).toContain(
    'Comando não enviado. A temperatura excede o limite da ferramenta.',
  )
})

test('cancelled Moonraker telemetry does not offer idle-only tool control', () => {
  const snapshot = {
    eventtime: 1,
    status: {
      webhooks: { state: 'ready' },
      print_stats: { state: 'cancelled' },
      virtual_sdcard: { progress: 0 },
    },
  } as any
  const state = normalizeMoonrakerSnapshot(snapshot, {
    printerKey: 'p',
    observedAt: Date.now(),
  } as any).printer.state
  expect(state).toBe('unknown')
  expect(
    controlActionAvailability('set_tool_temperature', row(state), keys, true, {
      wall: Date.now(),
      mono: performance.now(),
    }).available,
  ).toBe(false)
  expect(
    controlActionAvailability('set_tool_temperature', row('idle'), keys, true, {
      wall: Date.now(),
      mono: performance.now(),
    }).available,
  ).toBe(true)
})
