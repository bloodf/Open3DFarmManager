import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { filamentLoadArgs } from '../../apps/farm/app/utils/filament-load.ts'
import { kobraXMapping } from '../../apps/farm/app/utils/kobra-x-inputs.ts'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'

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
})

it('creates the load command only for a chosen slot', async () => {
  expect(filamentLoadArgs(undefined)).toBeUndefined()
  expect(filamentLoadArgs({ id: 3 })).toEqual({ tray: 3 })
  const source = await readFile(
    new URL(
      '../../apps/farm/app/pages/impressoras/[printerKey].vue',
      import.meta.url,
    ),
    'utf8',
  )
  expect(source).toContain("control('load_filament', event, args)")
  expect(source).toContain('role="alert"')
  expect(source).toContain('Entrada selecionada:')
  expect(source).toContain('for="detail-load-filament-input"')
})
