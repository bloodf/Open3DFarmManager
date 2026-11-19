import { expect, it } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import { detailTabs } from '../../apps/farm/app/utils/printer-detail-view.ts'

it('keeps cached system readings visible and disables restarts offline', async () => {
  const html = await renderFarmComponent(
    '../printer-detail/SystemServicesPanel.vue',
    {
      firmware: { state: 'error', message: '<Klipper indisponível>' },
      host: { cpuLoad: 9.5, memoryBytes: 1048576, temperatureC: 47 },
      updates: [{ name: 'klipper', installed: 'v1', available: 'v2' }],
      canCommand: false,
      reason: 'Sem conexão direta.',
    },
  )
  for (const text of [
    '&lt;Klipper indisponível&gt;',
    '9,5%',
    '1 MiB',
    '47 °C',
    'v1',
    'v2',
    'Sem conexão direta.',
    'Reiniciar Klipper',
    'Reiniciar firmware',
    'Reiniciar Moonraker',
  ])
    expect(html).toContain(text)
  expect(html).toContain('<fieldset disabled>')
  expect(html).not.toMatch(/>\s*(Atualizar|Verificar atualizações)\s*</)
})

it('hides an unadvertised Sistema tab and retains its catalog reason', () => {
  const { available, unavailable } = detailTabs(['heaters'], {
    system: 'Sem suporte no catálogo.',
  })
  expect(available.map(({ id }) => id)).not.toContain('sistema')
  expect(unavailable.find(({ id }) => id === 'sistema')?.reason).toBe(
    'Sem suporte no catálogo.',
  )
  expect(detailTabs(['system']).available.map(({ id }) => id)).toContain(
    'sistema',
  )
})
