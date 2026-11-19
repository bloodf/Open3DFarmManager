import { describe, expect, it, vi } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'

const component = '../printer-detail/ConfigEditorPanel.vue'

describe('config editor panel', () => {
  it('exposes labeled file selection and a live operation status', async () => {
    const list = vi.fn()
    const html = await renderFarmComponent(component, {
      list,
      read: vi.fn(),
      save: vi.fn(),
    })
    expect(html).toContain('Configuração do Klipper')
    expect(html).toContain('Listar arquivos')
    expect(html).toContain('Arquivo de configuração')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('<textarea')
    expect(list).not.toHaveBeenCalled()
  })

  it('renders the availability reason and disables file actions', async () => {
    const reason =
      'Apenas proprietários e administradores podem editar a configuração.'
    const html = await renderFarmComponent(component, {
      reason,
      list: vi.fn(),
      read: vi.fn(),
      save: vi.fn(),
    })
    expect(html).toContain(reason)
    expect(html).toMatch(/<fieldset[^>]* disabled/)
  })
})
