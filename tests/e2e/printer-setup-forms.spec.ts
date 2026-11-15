import { expect, test } from '@playwright/test'
import { setupFormsBundle } from './mount-setup-forms.ts'

test.beforeEach(async ({ page }) => {
  await page.goto('/healthz')
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="fixture"></div>'
  })
  await page.addScriptTag({ content: await setupFormsBundle() })
  await page.evaluate(() =>
    (window as any).mountSetupForms(document.querySelector('#fixture')),
  )
})

test('forms expose unique labelled controls and validate each family', async ({
  page,
}) => {
  const family = page.getByLabel('Família da impressora')
  for (const [value, label, invalid] of [
    [
      'klipper-moonraker',
      'Origem HTTP(S) do Moonraker',
      'http://example.com/path',
    ],
    ['bambu-lan', 'Endereço IPv4 da Bambu Lab na LAN', 'bad'],
    ['creality-native', 'Endereço IPv4 da Creality na LAN', 'bad'],
    ['anycubic-lan', 'Endereço IPv4 na LAN', 'bad'],
  ]) {
    await family.selectOption(value)
    const ids = await page
      .locator('[id]')
      .evaluateAll((nodes) => nodes.map((node) => node.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const input of await page.locator('input, select').all()) {
      expect(
        await input.evaluate(
          (node) => (node as HTMLInputElement).labels?.length,
        ),
      ).toBeGreaterThan(0)
    }
    await page.getByLabel(label, { exact: true }).fill(invalid)
    if (value === 'bambu-lan') {
      await page.getByLabel('Número de série').fill('ABC123')
      await page.getByLabel('Código de acesso LAN').fill('secret123')
    }
    if (value === 'anycubic-lan') {
      await page.getByLabel('Identificador do modelo').fill('model')
      await page.getByLabel('Identificador do dispositivo').fill('device')
      await page.getByLabel('Usuário LAN').fill('user')
      await page.getByLabel('Senha LAN').fill('secret123')
    }
    await page.getByRole('button', { name: /^Preparar/ }).click()
    const messages: Record<string, string> = {
      'klipper-moonraker': 'Informe uma origem HTTP(S)',
      'bambu-lan': 'Informe o endereço IPv4 da impressora',
      'creality-native': 'Informe o endereço IPv4 da Creality',
      'anycubic-lan':
        'Informe IPv4, porta, modelo, identidade e credenciais LAN válidos.',
    }
    await expect(page.getByRole('alert')).toContainText(messages[value]!)
    await expect(page.getByRole('alert')).not.toContainText('secret123')
  }
})

test('Moonraker rejects mixed credentials and secrets stay out of rendered text', async ({
  page,
}) => {
  await page
    .getByLabel('Família da impressora')
    .selectOption('klipper-moonraker')
  await page
    .getByLabel('Origem HTTP(S) do Moonraker')
    .fill('http://192.168.1.20:7125')
  await page.getByLabel('Chave de API (opcional)').fill('secret-key')
  await page.getByLabel('Usuário (alternativa à chave)').fill('operator')
  await page.getByLabel('Senha', { exact: true }).fill('secret-password')
  await page
    .getByRole('button', { name: 'Preparar Klipper / Moonraker' })
    .click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.locator('main')).not.toContainText('secret-key')
  await expect(page.locator('main')).not.toContainText('secret-password')
  await expect(page.getByLabel('Senha', { exact: true })).toHaveAttribute(
    'type',
    'password',
  )
  await page.getByLabel('Usuário (alternativa à chave)').clear()
  await page.getByLabel('Senha', { exact: true }).clear()
  await page
    .getByRole('button', { name: 'Preparar Klipper / Moonraker' })
    .click()
  await expect(page.getByRole('alert')).toHaveText(
    'Configuração não disponível neste Connector.',
  )
  await page.getByLabel('Chave de API (opcional)').clear()
  await page.getByLabel('Usuário (alternativa à chave)').fill('operator')
  await page.getByLabel('Senha', { exact: true }).fill('secret-password')
  await page
    .getByRole('button', { name: 'Preparar Klipper / Moonraker' })
    .click()
  await expect(page.getByRole('alert')).toHaveText(
    'Configuração não disponível neste Connector.',
  )
})

test('discovery selection and probe prefill the form and keyboard can select', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Procurar impressoras' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Selecionar Bambu' }).click()
  await expect(
    page.getByLabel('Endereço IPv4 da Bambu Lab na LAN'),
  ).toHaveValue('192.168.1.21')
  await expect(page.getByLabel('Número de série')).toHaveValue('ABC123')
  await page.getByLabel('Endereço IPv4 da impressora').fill('192.168.1.22')
  await page.getByRole('button', { name: 'Identificar' }).click()
  await expect(page.getByLabel('Endereço IPv4 da Creality na LAN')).toHaveValue(
    '192.168.1.22',
  )
})
