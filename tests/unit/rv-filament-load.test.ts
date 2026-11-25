import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { filamentTrays } from '../../apps/farm/app/utils/farm-macros.ts'
import { slotLabel } from '../../apps/farm/app/utils/spool-features-format.ts'
import {
  farmSlotLabel,
  slotBindingKey,
  verifiedSlotBindings,
} from '../../apps/farm/app/utils/slot-spools.ts'
import type { SpoolItem } from '../../apps/farm/app/utils/spool-library-types.ts'
import { ControlArguments } from '../../packages/farm-protocol/src/control-actions.ts'
import { buildBambuCommand } from '../../packages/connector/src/bambu/commands.ts'
import { decodeBambuAms } from '../../packages/connector/src/bambu/ams.ts'
import { withBrowser } from '../helpers/browser'

const app = resolve(import.meta.dirname, '../../apps/farm')
const components = join(app, 'app/components')
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc')

function compile(source: string, filename: string): string {
  const { descriptor, errors } = sfc.parse(source, { filename })
  if (errors.length) throw errors[0]
  return sfc.compileScript(descriptor, { id: filename, inlineTemplate: true })
    .content
}

/** Bundles a harness component around the production components it imports. */
async function bundle(source: string): Promise<string> {
  const vuePlugin: Plugin = {
    name: 'vue-sfc',
    setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compile(readFileSync(path, 'utf8'), path),
        loader: 'ts',
        resolveDir: join(path, '..'),
      }))
    },
  }
  const script = compile(source, join(components, 'Harness.vue'))
  const result = await build({
    stdin: {
      contents: `${script.replace('export default', 'const component =')}\nimport { createApp } from 'vue'; createApp(component).mount('#root')`,
      loader: 'ts',
      resolveDir: components,
    },
    plugins: [vuePlugin],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    nodePaths: [join(app, '../../node_modules')],
  })
  return result.outputFiles[0]!.text
}

/** AMS HT units 128 and 135 plus both external holders, as the Connector decodes them. */
const { materials } = decodeBambuAms({
  ams: {
    ams: [
      { id: '0', tray: [{ id: '1', tray_type: 'PLA' }] },
      { id: '128', tray: [{ id: '0', tray_type: 'PA-CF' }] },
      { id: '135', tray: [{ id: '0', tray_type: 'PETG' }] },
    ],
  },
  vir_slot: [
    { id: '255', tray_type: 'ABS' },
    { id: '254', tray_type: 'TPU' },
  ],
})
const state = { materials } as Parameters<typeof filamentTrays>[0]

describe('#881 AMS HT and two external holders', () => {
  it('labels every decoded slot in pt-BR', () => {
    expect(materials.map(({ slot }) => farmSlotLabel(slot))).toEqual([
      'AMS 1, bandeja 2',
      'AMS HT 1',
      'AMS HT 8',
      'Bobina externa',
      'Bobina externa 2',
    ])
    expect(slotLabel('ams', 128)).toBe('AMS HT 1')
    expect(slotLabel('ams', 135)).toBe('AMS HT 8')
    expect(slotLabel('ams', 136)).toBe('AMS 137')
  })

  it('gives each slot its own binding key and finds the bound spool', () => {
    expect(materials.map(({ slot }) => slotBindingKey(slot))).toEqual([
      'ams:1',
      'ams:128',
      'ams:135',
      'printer:0',
      'printer:1',
    ])
    const bound = verifiedSlotBindings(
      [
        {
          id: 'a',
          spoolId: 7,
          printerId: 'p',
          slotKind: 'printer',
          slotIndex: 1,
          assignedAt: 1,
          unassignedAt: null,
        },
      ],
      [
        {
          id: 7,
          remaining_weight: 250,
          initial_weight: 1000,
          filament: {},
        } as unknown as SpoolItem,
      ],
    ).get('p')
    expect(bound?.get(slotBindingKey('external:254'))).toEqual({
      remainingGrams: 250,
      initialGrams: 1000,
    })
    expect(bound?.get(slotBindingKey('external'))).toBeUndefined()
  })

  it('keeps slot ids outside the known ranges unknown', () => {
    for (const slot of [
      'ams:127:0',
      'ams:128:1',
      'ams:136:0',
      'external:253',
    ]) {
      expect(farmSlotLabel(slot)).toBe(slot)
      expect(slotBindingKey(slot)).toBe('printer:-1')
      expect(filamentTrays({ materials: [{ slot }] } as never)).toEqual([])
    }
  })

  it('offers AMS HT trays for loading, but no external holder', () => {
    expect(filamentTrays(state).map(({ id, label }) => [id, label])).toEqual([
      [1, 'ams:0:1 — PLA'],
      [128, 'AMS HT 1 — PA-CF'],
      [135, 'AMS HT 8 — PETG'],
    ])
  })

  it('signs every offered tray into the request the Connector builds', () => {
    for (const id of [1, 128, 135]) {
      expect(
        ControlArguments.safeParse({
          action: 'load_filament',
          args: { tray: id },
        }).success,
      ).toBe(true)
      expect(
        buildBambuCommand('load_filament', { tray: id, target_c: 220 }),
      ).toMatchObject({ print: { target: id } })
    }
    for (const tray of [16, 127, 128.5, 136, 254, 255])
      expect(
        ControlArguments.safeParse({
          action: 'load_filament',
          args: { tray },
        }).success,
      ).toBe(false)
  })
})

describe('#878 filament load controls', () => {
  it('flags a vanished AMS tray, disables the button and says why', async () => {
    const script = await bundle(`<script setup lang="ts">
import { shallowRef } from 'vue'
import FarmMacrosControls from './FarmMacrosControls.vue'
const now = { wall: Date.now(), mono: performance.now() }
const keys = { kind: 'available', selected: 'synthetic-key', choices: [] }
const row = (materials: unknown[]) => ({ assignment: { assignmentId: 'a', printerKey: 'Bambu', status: 'active', connectorStatus: 'approved' }, connection: 'authenticated', observation: { state: { state: 'idle', observedAt: now.wall, controls: ['load_filament'], materials }, received: now, historical: false, sourceClockComparable: true } })
const current = shallowRef(row([{ slot: 'ams:0:0' }, { slot: 'ams:128:0' }]))
const issued: unknown[] = []
Object.assign(window, { issued, setSlots: (slots: string[]) => { current.value = row(slots.map((slot) => ({ slot }))) } })
</script>
<template><FarmMacrosControls :row="current" :keys="keys" :control-enabled="true" :command-in-flight="false" :now="now" @action="(action, args) => issued.push({ action, args })" /></template>`)
    await withBrowser({}, async (browser) => {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: script })
      const select = page.getByRole('combobox', { name: /Bandeja AMS/ })
      const button = page.getByRole('button', { name: 'Carregar filamento' })
      await select.selectOption('128')
      expect(await button.isEnabled()).toBe(true)
      expect(await select.getAttribute('aria-invalid')).toBeNull()

      // Every tray leaves: the select must stay, flagged, with a reason.
      for (const slots of [['ams:0:0'], []]) {
        await page.evaluate(
          (next) =>
            (window as unknown as { setSlots(s: string[]): void }).setSlots(
              next,
            ),
          slots,
        )
        await page.getByRole('alert').waitFor()
        expect(await button.isDisabled()).toBe(true)
        expect(await select.getAttribute('aria-invalid')).toBe('true')
        expect(await select.inputValue()).toBe('128')
        const reason = await page.getByRole('alert').textContent()
        expect(reason).toContain('não está mais disponível')
        for (const control of [select, button]) {
          const id = await control.getAttribute('aria-describedby')
          expect(await page.locator(`[id="${id}"]`).textContent()).toBe(reason)
        }
      }

      // Choosing again is explicit; automatic selection is never assumed.
      await select.selectOption('')
      expect(await page.getByRole('alert').count()).toBe(0)
      await button.click()
      expect(
        await page.evaluate(
          () => (window as unknown as { issued: unknown[] }).issued,
        ),
      ).toEqual([{ action: 'load_filament', args: {} }])
      expect(errors).toEqual([])
    })
  })

  const detail = readFileSync(
    join(app, 'app/pages/impressoras/[printerKey].vue'),
    'utf8',
  )
  function between(start: string, end: string) {
    const from = detail.indexOf(start)
    const to = detail.indexOf(end, from)
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    return detail.slice(from, to + end.length)
  }

  it('renders the Kobra load group outside the print form, only when offered', async () => {
    const form = between(
      '      <form\n        v-if="state?.controls',
      '</form>',
    )
    expect(form).not.toContain('load_filament')
    expect(form).not.toContain('detail-load-filament')

    // The production group and handler, mounted with the page state they read.
    const group = between('      <fieldset', '</fieldset>')
    const handler = between('function loadFilament(', '\n}\n')
    const script = await bundle(`<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import Button from './ui/Button.vue'
import { filamentLoadArgs } from '../utils/filament-load.ts'
const offered = ref(['start_print'])
const state = computed(() => ({ controls: offered.value }))
const vendorFrame = ref({ vendor: 'kobra-x' })
const availableKobraInputs = ref([{ id: 4, label: 'ACE 1' }])
const selectedLoadInputId = ref('')
const loadInputError = ref('')
const loadInputSelect = ref<HTMLSelectElement | null>(null)
const selectedLoadInput = computed(() => availableKobraInputs.value.find((input) => String(input.id) === selectedLoadInputId.value))
const commandInFlight = false
const availability = (_action: string) => ({ available: true })
const issued: unknown[] = []
function control(action: string, _event: Event, args: unknown) { issued.push({ action, args }) }
${handler}
Object.assign(window, { issued, offer: (controls: string[]) => { offered.value = controls } })
</script>
<template><div>
${group}
</div></template>`)
    await withBrowser({}, async (browser) => {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: script })
      expect(await page.getByRole('combobox').count()).toBe(0)
      expect(await page.getByRole('button').count()).toBe(0)

      await page.evaluate(() =>
        (window as unknown as { offer(c: string[]): void }).offer([
          'load_filament',
        ]),
      )
      const named = page.getByRole('group', {
        name: 'Carregamento de filamento',
      })
      const select = named.getByRole('combobox', {
        name: 'Entrada para carregar',
      })
      const button = named.getByRole('button', { name: 'Carregar filamento' })
      // Tab order: the select comes before the button that uses it.
      await select.focus()
      await page.keyboard.press('Tab')
      expect(
        await button.evaluate((node) => node === document.activeElement),
      ).toBe(true)

      await button.click()
      await page.waitForFunction(
        () => document.activeElement?.id === 'detail-load-filament-input',
      )
      expect(await select.getAttribute('aria-invalid')).toBe('true')
      expect(await select.getAttribute('aria-describedby')).toBe(
        'detail-load-filament-error',
      )
      await select.selectOption('4')
      expect(await select.getAttribute('aria-invalid')).toBeNull()
      await button.click()
      expect(
        await page.evaluate(
          () => (window as unknown as { issued: unknown[] }).issued,
        ),
      ).toEqual([{ action: 'load_filament', args: { tray: 4 } }])
      expect(errors).toEqual([])
    })
  })
})
