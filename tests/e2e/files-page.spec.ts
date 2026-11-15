import { expect, test } from '@playwright/test'
import { filesPageBundle } from './mount-files-page.ts'

test('Arquivos valida, envia, cancela e inicia somente com suporte', async ({
  page,
}) => {
  await page.goto('/healthz')
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="fixture"></div>'
  })
  await page.addScriptTag({ content: await filesPageBundle() })
  await page.evaluate(() =>
    (window as any).mountFilesPage(document.querySelector('#fixture')),
  )
  const printer = page.getByLabel('Impressora', { exact: true })
  await printer.selectOption('Supported')
  const upload = page.locator('#files-upload')
  const send = page.getByRole('button', { name: 'Enviar arquivo' })
  await upload.setInputFiles({
    name: 'wrong.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('abc'),
  })
  await expect(send).toBeDisabled()
  await expect(page.getByRole('status').last()).toContainText('.gcode ou .3mf')
  await upload.setInputFiles({
    name: 'empty.gcode',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(0),
  })
  await expect(send).toBeDisabled()
  await expect(page.getByRole('status').last()).toContainText(
    '1 byte e 512 MiB',
  )
  await upload.evaluate((input: HTMLInputElement) => {
    const file = new File(['x'], 'large.gcode')
    Object.defineProperty(file, 'size', { value: 512 * 1024 * 1024 + 1 })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(send).toBeDisabled()
  await expect(page.getByRole('status').last()).toContainText(
    '1 byte e 512 MiB',
  )
  await upload.setInputFiles({
    name: 'cube.gcode',
    mimeType: 'text/plain',
    buffer: Buffer.from('1234'),
  })
  await send.click()
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '2')
  await page.getByRole('button', { name: 'Cancelar operação' }).click()
  await expect(page.getByRole('status').last()).toContainText(
    'Operação cancelada',
  )
  await printer.selectOption('Unsupported')
  await page.getByRole('button', { name: 'Consultar arquivos' }).click()
  await expect(page.getByRole('status').last()).toContainText('não suportada')
  await upload.setInputFiles({
    name: 'cube.gcode',
    mimeType: 'text/plain',
    buffer: Buffer.from('1234'),
  })
  await send.click()
  await expect(page.getByRole('status').last()).toContainText(
    'Envio não suportado',
  )
  await printer.selectOption('No start')
  await expect(
    page.getByText('A impressora não anuncia suporte para iniciar impressão.'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Consultar arquivos' }),
  ).toBeDisabled()
  await printer.selectOption('Supported')
  const list = page.getByRole('button', { name: 'Consultar arquivos' })
  await list.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('list', { name: 'Miniaturas dos arquivos' }).locator('img'),
  ).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=')
  await page.getByLabel('Arquivo para imprimir').selectOption('cube.gcode')
  await expect(
    page.getByRole('button', { name: 'Iniciar impressão' }),
  ).toBeDisabled()
  await page.getByRole('checkbox').focus()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Iniciar impressão' }).click()
  await expect(page.getByRole('status').last()).toContainText(
    'Impressão iniciada',
  )
  expect(await page.evaluate(() => (window as any).filesCommands)).toEqual([
    { action: 'start_print', args: { file: 'cube.gcode' } },
  ])
})
