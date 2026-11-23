import { expect, test, type Page } from '@playwright/test'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import {
  startKobraXMock,
  type KobraXMockInstance,
} from '../../packages/sim-tools/src/mocks/index.ts'
import { farmControlsBundle } from './mount-farm-controls.ts'

// Loopback Kobra X mock and the native adapter. The farm page is the production
// controls bound to what the adapter reports and advertises. Every command the
// page issues is carried out by the adapter on the mock and judged on the outcome.
// Credentials come from the adapter's native /ctrl recovery against the mock,
// which checks the documented query shape (strictCtrlQuery).
const signed = { beforeSend: () => true }

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 150 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  expect(check(), label).toBe(true)
}

async function mountPrinter(page: Page, printer: object) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'synthetic-ui-account' } }),
  )
  await page.goto('/farm')
  // Let the page settle (no farm data loads here) so its re-render does not
  // drop the mount target appended below.
  await expect(page.getByRole('alert')).toBeVisible()
  await page.evaluate((value) => {
    ;(window as any).farmControlsPrinters = [value]
    const target = document.createElement('div')
    target.id = 'controls-fixture'
    document.querySelector('main')!.append(target)
  }, printer)
  await page.addScriptTag({ content: await farmControlsBundle() })
  await page.evaluate(() =>
    (window as any).mountFarmControls(
      document.querySelector('#controls-fixture'),
    ),
  )
}

const issued = (page: Page) =>
  page.evaluate(() => (window as any).farmControlsIssued as any[])

test.describe('Kobra X on the farm page', () => {
  let mock: KobraXMockInstance
  let adapter: Awaited<ReturnType<typeof connectKobraX>>
  const printer = () => ({
    name: 'Kobra X',
    state: adapter.snapshot().state,
    controls: [...adapter.control.advertised()],
  })

  test.beforeEach(async () => {
    mock = await startKobraXMock({
      reportIntervalMs: 0,
      preparationPhases: [],
      strictCtrlQuery: true,
    })
    adapter = await connectKobraX({
      address: '127.0.0.1',
      printerKey: 'Kobra X',
      clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
      httpPort: mock.httpPort,
      mqttPort: mock.mqttPort,
      resultTimeoutMs: 1000,
      motionResultTimeoutMs: 1000,
    })
    await until(
      () =>
        adapter.snapshot().state === 'idle' &&
        adapter.facts().infoState === 'free',
      'idle printer',
    )
  })
  test.afterEach(async () => {
    await adapter.close()
    await mock.close()
  })

  test('idle: confirmed commands from the page home, light and heat the mock', async ({
    page,
  }) => {
    await mountPrinter(page, printer())
    const card = page.getByRole('article', { name: 'Kobra X' })
    // The adapter advertises pause; while idle the page keeps it disabled and says why.
    const pause = card.getByRole('button', { name: 'Pausar', exact: true })
    await expect(pause).toBeDisabled()
    await expect(
      card.getByText('Pausa indisponível. A impressora não está imprimindo.'),
    ).toBeVisible()
    await expect(
      card.getByRole('button', { name: 'Referenciar eixos' }),
    ).toBeVisible()

    await card.getByRole('button', { name: 'Referenciar eixos' }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirmar comando' })
      .click()
    await card.getByRole('button', { name: 'Definir luz' }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirmar comando' })
      .click()
    const commands = await issued(page)
    expect(commands.map((c) => c.action)).toEqual(['home', 'set_light'])

    for (const command of commands) {
      const outcome = await adapter.control.execute(
        command.action,
        command.args,
        signed,
      )
      expect(outcome.kind, command.action).toBe('confirmed')
    }
    const wire = mock.calls.all.map((m) => m.topic.split('/').at(-1))
    expect(wire).toContain('axis')
    expect(wire).toContain('light')
  })

  test('printing: the page offers pause and the adapter refuses motion before publishing', async ({
    page,
  }) => {
    await mock.control.startPrint('plate.gcode', { preparationPhases: [] })
    await until(() => adapter.snapshot().state === 'printing', 'printing')
    await mountPrinter(page, printer())
    const card = page.getByRole('article', { name: 'Kobra X' })
    await expect(card.getByRole('button', { name: 'Pausar' })).toBeVisible()

    await card.getByRole('button', { name: 'Pausar', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirmar pausa' })
      .click()
    const [command] = await issued(page)
    expect(command.action).toBe('pause')
    const paused = await adapter.control.execute(
      command.action,
      command.args,
      signed,
    )
    expect(paused.kind).toBe('confirmed')
    await until(() => adapter.snapshot().state === 'paused', 'paused')
    expect(mock.control.getState().state).toBe('paused')

    // Motion while a job runs never reaches the printer, even if a page asks for it.
    const before = mock.calls.all.length
    const home = await adapter.control.execute(
      'home',
      { axes: ['x', 'y', 'z'] },
      signed,
    )
    expect(home).toEqual({
      kind: 'refused',
      stage: 'local',
      reason: 'job-active',
    })
    expect(mock.calls.all.length).toBe(before)
  })
})
