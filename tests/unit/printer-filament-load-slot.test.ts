import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, it } from 'vitest'
import { filamentLoadArgs } from '../../apps/farm/app/utils/filament-load.ts'
import { kobraXMapping } from '../../apps/farm/app/utils/kobra-x-inputs.ts'
import { createPageHarness } from '../helpers/page-harness.ts'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'

const app = resolve(import.meta.dirname, '../../apps/farm/app')
const helpers = resolve(import.meta.dirname, '../helpers')

/** Mounts the real printer page over one live, idle Kobra X. */
async function withPrinterPage(use: (page: Page) => Promise<void>) {
  const harness = await createPageHarness({
    replace: {
      [resolve(app, 'composables/useFarmView.ts')]: resolve(
        helpers,
        'load-filament-view-stub.ts',
      ),
      [resolve(app, 'components/farm/useFarmControls.ts')]: resolve(
        helpers,
        'load-filament-controls-stub.ts',
      ),
    },
  })
  try {
    const { page } = await harness.open(
      'impressoras/[printerKey]',
      {},
      { route: { params: { printerKey: 'synthetic-printer' } } },
    )
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await use(page)
    expect(errors).toEqual([])
  } finally {
    await harness.close()
  }
}

const issued = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __controls?: unknown[] }).__controls ?? [],
  )

it('keeps the load slot separate from the print mapping', async () => {
  const inputs = [
    { id: 0, label: 'Suporte 1' },
    { id: 4, label: 'ACE 1' },
  ]
  let loadSlot = '4'
  const mapping = kobraXMapping(['0'], 1, inputs)
  expect(mapping).toEqual([0])
  expect(
    filamentLoadArgs(inputs.find(({ id }) => String(id) === loadSlot)),
  ).toEqual({
    tray: 4,
  })
  loadSlot = '0'
  expect(mapping).toEqual([0])
  expect(
    filamentLoadArgs(inputs.find(({ id }) => String(id) === loadSlot)),
  ).toEqual({
    tray: 0,
  })

  const renderedButton = await renderFarmComponent('../ui/Button.vue', {
    type: 'button',
  })
  expect(renderedButton).toContain('<button type="button"')

  await withPrinterPage(async (page) => {
    const load = page.getByLabel('Entrada para carregar')
    const mapped = page.getByLabel('Entrada do filamento 1')
    const loadButton = page.getByRole('button', { name: 'Carregar filamento' })
    const print = page.getByRole('button', { name: 'Iniciar impressão' })
    const close = () =>
      page.evaluate(() => document.querySelector('dialog')!.close())

    await page.getByLabel('Nome do arquivo na impressora').fill('peca.gcode')
    await mapped.selectOption({ label: 'Suporte 1' })
    for (const slot of ['ACE 1', 'Suporte 1', 'ACE 1']) {
      await load.selectOption({ label: slot })
      expect(await mapped.inputValue()).toBe('0')
      await loadButton.click()
      await close()
      await print.click()
      await close()
    }
    // Changing the print mapping leaves the load slot alone.
    await mapped.selectOption({ label: 'ACE 1' })
    expect(await load.inputValue()).toBe('4')

    const start = {
      action: 'start_print',
      args: { file: 'peca.gcode', ams_mapping: [0] },
    }
    expect(await issued(page)).toEqual(
      [4, 0, 4].flatMap((tray) => [
        { action: 'load_filament', args: { tray } },
        start,
      ]),
    )
  })
}, 120_000)

it('creates the load command only for a chosen slot', async () => {
  expect(filamentLoadArgs(undefined)).toBeUndefined()
  expect(filamentLoadArgs({ id: 3 })).toEqual({ tray: 3 })

  await withPrinterPage(async (page) => {
    // `for="detail-load-filament-input"` gives the select its name.
    const load = page.getByRole('combobox', { name: 'Entrada para carregar' })
    expect(await load.getAttribute('id')).toBe('detail-load-filament-input')
    const button = page.getByRole('button', { name: 'Carregar filamento' })
    expect(await button.getAttribute('type')).toBe('button')

    expect(await page.getByRole('alert').count()).toBe(0)
    await button.click()
    expect(await page.getByRole('alert').textContent()).toBe(
      'Selecione uma entrada de filamento para carregar.',
    )
    expect(await issued(page)).toEqual([])
    expect(await page.getByRole('dialog').count()).toBe(0)

    await load.selectOption({ label: 'ACE 1' })
    expect(await page.getByRole('alert').count()).toBe(0)
    await button.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    expect((await dialog.textContent())!.replace(/\s+/g, ' ')).toContain(
      'Entrada selecionada: ACE 1.',
    )
    expect(await issued(page)).toEqual([
      { action: 'load_filament', args: { tray: 4 } },
    ])
  })
}, 120_000)
