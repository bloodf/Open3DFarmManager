import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { renderSpoolInventory } from './render-spool-inventory.ts'
import { cameraDisplayBundle } from './mount-camera-display.ts'

// Isolated UI checks only. Use playwright.farm-view.config.ts with a built app.
// FARM_VIEW_E2E=true selects these tests; the default flag-off suite stays unchanged.
test.skip(
  process.env.FARM_VIEW_E2E !== 'true',
  'Requires an opt-in farmView build; does not prove real DB/auth/RTC acceptance.',
)
const farm = '00000000-0000-4000-8000-000000000001'
const agent = '00000000-0000-4000-8000-000000000002'
const assignment = '00000000-0000-4000-8000-000000000003'
const key = `  e\u0301/<script>打印机</script> ${'x'.repeat(60)}  `
async function inventory(page: Page) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'synthetic-ui-account' } }),
  )
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [{ farmId: farm }], nextAfter: null } }),
  )
  await page.route(`**/api/farms/${farm}/printers?*`, (route) =>
    route.fulfill({
      json: {
        printers: [
          {
            assignmentId: assignment,
            agentId: agent,
            printerKey: key,
            status: 'active',
            connectorStatus: 'approved',
          },
        ],
        nextAfter: null,
        canManage: true,
      },
    }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    route.fulfill({
      json: {
        currentAccountId: 'synthetic-ui-account',
        currentRole: 'owner',
        devices: [],
        nextAfter: null,
        limits: {
          pendingLifetimeMs: 86_400_000,
          proofLifetimeMs: 60_000,
          maxChallengesPerKey: 3,
        },
      },
    }),
  )
}

test('pt-BR inventory wraps exact keys at 320px, separates approval from status, and always disables pause', async ({
  page,
}) => {
  await inventory(page)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/farm')
  await expect(
    page.getByRole('heading', { name: 'Minha farm', exact: true }),
  ).toBeFocused()
  await expect(page.getByLabel('Farm atual', { exact: true })).toHaveValue(farm)
  await expect(page.locator(`#printer-${assignment}`)).toHaveText(key)
  expect(
    await page
      .locator(`#printer-${assignment}`)
      .evaluate((node) => node.textContent),
  ).toBe(key)
  await expect(page.getByRole('article')).toContainText('Connector aprovado')
  await expect(page.getByRole('article')).toContainText(
    'Conexão direta indisponível',
  )
  await expect(page.getByRole('article')).toContainText(
    'Nenhum estado recebido',
  )
  await expect(
    page.getByRole('button', { name: 'Pausar impressão' }),
  ).toBeDisabled()
  await expect(page.locator('progress')).toHaveCount(0)
  // Spool inventory is read-only and reports unavailability without a direct connection.
  await expect(
    page.getByRole('heading', { name: 'Estoque de filamento', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Estoque indisponível sem conexão direta com o Connector.'),
  ).toBeVisible()
  await expect(page.locator('table')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})

test('explicit origin setup has no outbound probe and renders an external anchor with privacy attributes', async ({
  page,
}) => {
  await inventory(page)
  const outbound: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith('http://printer.invalid'))
      outbound.push(request.url())
  })
  await page.goto('/farm')
  const setup = page.getByRole('button', {
    name: 'Configurar interface local',
    exact: true,
  })
  await setup.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(
    page.getByLabel('Origem da interface local', { exact: true }),
  ).toBeFocused()
  await page
    .getByLabel('Origem da interface local', { exact: true })
    .fill('http://printer.invalid:8080/')
  await expect(page.getByRole('article')).toContainText(
    'Origem para conferir: http://printer.invalid:8080',
  )
  await page.keyboard.press('Tab')
  const confirmation = page.getByLabel(
    'Conferi que este endereço abre a interface local desta impressora.',
  )
  await expect(confirmation).toBeFocused()
  await page.keyboard.press('Space')
  await expect(confirmation).toBeChecked()
  await page.keyboard.press('Tab')
  const confirm = page.getByRole('button', {
    name: 'Confirmar interface local',
  })
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Enter')
  const link = page.getByRole('link', { name: /Abrir interface local de/ })
  await expect(link).toHaveAttribute('href', 'http://printer.invalid:8080')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
  expect(outbound).toEqual([])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(link).toHaveCount(0)
  await expect(page.getByRole('article')).toContainText(
    'Nenhum estado recebido',
  )
})

test('unauthenticated and failed requests never render a false empty inventory', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: {} }),
  )
  await page.goto('/farm')
  await expect(
    page.getByRole('link', { name: 'Entrar', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(0)
  await expect(
    page.getByText('Nenhuma impressora atribuída a esta farm.'),
  ).toHaveCount(0)
  await page.unroute('**/api/auth/me')
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert')).toHaveText(
    'Não foi possível confirmar seus dados. Tente novamente.',
  )
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByRole('article')).toHaveCount(0)
})

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  return result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({
      target: n.target,
      failureSummary: n.failureSummary,
    })),
  }))
}

for (const width of [320, 1280]) {
  test(`axe finds no WCAG A/AA violations in the farm inventory at ${width}px`, async ({
    page,
  }) => {
    await inventory(page)
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/farm')
    await expect(page.locator(`#printer-${assignment}`)).toHaveText(key)
    expect(await violations(page)).toEqual([])
  })
}

test('axe finds no WCAG A/AA violations with the local interface form open and confirmed', async ({
  page,
}) => {
  await inventory(page)
  await page.goto('/farm')
  await page
    .getByRole('button', { name: 'Configurar interface local', exact: true })
    .click()
  await page
    .getByLabel('Origem da interface local', { exact: true })
    .fill('http://printer.invalid:8080/')
  expect(await violations(page)).toEqual([])
  await page
    .getByLabel(
      'Conferi que este endereço abre a interface local desta impressora.',
    )
    .check()
  await page.getByRole('button', { name: 'Confirmar interface local' }).click()
  await expect(
    page.getByRole('link', { name: /Abrir interface local de/ }),
  ).toBeVisible()
  expect(await violations(page)).toEqual([])
})

test('axe finds no WCAG A/AA violations in the sign-in and service-error states', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: {} }),
  )
  await page.goto('/farm')
  await expect(
    page.getByRole('link', { name: 'Entrar', exact: true }),
  ).toBeVisible()
  expect(await violations(page)).toEqual([])
  await page.unroute('**/api/auth/me')
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert')).toBeFocused()
  expect(await violations(page)).toEqual([])
})

const spool = (overrides: Record<string, unknown> = {}) => ({
  name: 'PLA Branco',
  material: 'PLA',
  colorHex: 'ffffff',
  remainingGrams: 742,
  location: 'Prateleira A',
  archived: false,
  ...overrides,
})
const clock = { wall: 1_000_000, mono: 1000 }
const observation = (inventory: unknown, mono = 1000) => ({
  agentId: agent,
  inventory,
  received: { wall: 1_000_000, mono },
})
const rows = [{ assignment: { agentId: agent, printerKey: 'impressora-1' } }]
async function showInventory(page: Page, items: unknown[], connected = true) {
  const { html, css } = await renderSpoolInventory({
    items,
    now: clock,
    connected,
    rows,
  })
  await page.setContent(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Estoque</title><style>${css}</style></head><body><main>${html}</main></body></html>`,
  )
}
for (const width of [320, 1280]) {
  test(`populated spool table is accessible and fits at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await showInventory(page, [
      observation({
        observedAt: 1,
        stale: false,
        total: 12,
        spools: [
          spool(),
          spool({
            name: null,
            material: null,
            colorHex: null,
            remainingGrams: null,
            location: null,
          }),
          spool({
            name: 'ABS Preto muito longo '.repeat(1),
            remainingGrams: -12,
            archived: true,
            colorHex: '000000',
          }),
        ],
      }),
    ])
    const table = page.getByRole('table')
    await expect(table).toBeVisible()
    await expect(table.getByRole('columnheader')).toHaveCount(6)
    await expect(table.getByRole('rowheader').first()).toHaveText('PLA Branco')
    await expect(table).toContainText('742 g')
    await expect(table).toContainText('-12 g')
    await expect(page.getByText('Exibindo parte do estoque')).toBeVisible()
    await expect(page.getByText('Desatualizado.')).toHaveCount(0)
    expect(await violations(page)).toEqual([])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
  })
}
test('stale, empty, truncated and unavailable inventories are distinguished', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 })
  const base = { observedAt: 1, stale: false }
  await showInventory(page, [
    observation({ ...base, stale: true, total: 0, spools: [] }),
  ])
  await expect(page.getByText('Desatualizado.')).toBeVisible()
  await expect(page.getByText('Nenhuma bobina cadastrada')).toBeVisible()
  await showInventory(page, [observation({ ...base, total: 5, spools: [] })])
  await expect(page.getByText('Exibindo 0 de 5 bobinas')).toBeVisible()
  await expect(page.getByText('Nenhuma bobina cadastrada')).toHaveCount(0)
  await showInventory(page, [observation(null)])
  await expect(page.getByText('Estoque indisponível.')).toBeVisible()
  await showInventory(page, [
    observation({ ...base, total: 0, spools: [] }, 1000 - 31_000),
  ])
  // Received more than 30 s ago counts as stale even if the Connector said fresh.
  await expect(page.getByText('Desatualizado.')).toBeVisible()
  expect(await violations(page)).toEqual([])
})

test('camera region is named, unavailable without an authorized stream, silent and axe-clean', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await inventory(page)
  await page.goto('/farm')
  const camera = page.getByRole('region', {
    name: `Câmera da impressora ${key}`,
  })
  await expect(camera).toBeVisible()
  await expect(camera.getByRole('status')).toHaveText('Câmera indisponível.')
  const video = camera.locator('video')
  await expect(video).toBeHidden()
  await expect(video).toHaveAttribute(
    'aria-label',
    `Imagem ao vivo da impressora ${key}, sem áudio`,
  )
  expect(
    await video.evaluate((node: HTMLVideoElement) => ({
      muted: node.muted,
      autoplay: node.autoplay,
      source: node.srcObject,
    })),
  ).toEqual({ muted: true, autoplay: false, source: null })
  await expect(
    page.getByRole('button', { name: 'Pausar impressão' }),
  ).toBeDisabled()
  expect(await violations(page)).toEqual([])
  const handle = await video.elementHandle()
  await page.getByRole('link', { name: 'Início', exact: true }).click()
  await expect(page).not.toHaveURL(/\/farm$/)
  expect(
    await handle!.evaluate((node: HTMLVideoElement) => node.srcObject),
  ).toBeNull()
})

// Stub live stream: a moving canvas, standing in for the authorized RTC track.
async function mountCamera(page: Page) {
  const { js, css } = await cameraDisplayBundle()
  await page.setContent(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Câmera</title><style>${css}</style></head><body><main><h1>Câmera</h1><div id="camera"></div></main></body></html>`,
  )
  await page.addScriptTag({ content: js })
  await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 48
    const context = canvas.getContext('2d')!
    let x = 0
    setInterval(() => {
      context.fillStyle = '#000'
      context.fillRect(0, 0, 64, 48)
      context.fillStyle = '#fff'
      context.fillRect((x = (x + 4) % 64), 16, 8, 16)
    }, 50)
    const w = window as unknown as Record<string, any>
    w.stub = canvas.captureStream(10)
    w.cameraDisplay.mount(document.getElementById('camera'), 'impressora-1')
  })
  return page.getByRole('region', { name: 'Câmera da impressora impressora-1' })
}
const setStub = (page: Page, on: boolean) =>
  page.evaluate((on) => {
    const w = window as unknown as Record<string, any>
    w.cameraDisplay.setStream(on ? w.stub : null)
  }, on)
const source = (page: Page) =>
  page.locator('video').evaluate((node: HTMLVideoElement) => node.srcObject)

test('live camera can always be stopped and shown again, is axe-clean, and detaches on revoke and unmount', async ({
  page,
}) => {
  const camera = await mountCamera(page)
  await setStub(page, true)
  await expect(camera.getByRole('status')).toHaveText('Câmera ao vivo.')
  await expect(camera.locator('video')).toBeVisible()
  expect(await violations(page)).toEqual([])
  await camera.getByRole('button', { name: 'Parar imagem ao vivo' }).click()
  await expect(camera.getByRole('status')).toHaveText('Imagem ao vivo parada.')
  expect(await source(page)).toBeNull()
  expect(await violations(page)).toEqual([])
  await camera.getByRole('button', { name: 'Mostrar imagem ao vivo' }).click()
  await expect(camera.getByRole('status')).toHaveText('Câmera ao vivo.')
  await setStub(page, false)
  await expect(camera.getByRole('status')).toHaveText('Câmera indisponível.')
  expect(await source(page)).toBeNull()
  await expect(camera.getByRole('button')).toHaveCount(0)
  await setStub(page, true)
  await expect(camera.getByRole('status')).toHaveText('Câmera ao vivo.')
  const handle = await page.locator('video').elementHandle()
  // Route leave unmounts the component; the stream must be detached.
  await page.evaluate(() =>
    (window as unknown as Record<string, any>).cameraDisplay.unmount(),
  )
  expect(
    await handle!.evaluate((node: HTMLVideoElement) => node.srcObject),
  ).toBeNull()
})

test('with reduced motion an available camera waits for the user and is axe-clean', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const camera = await mountCamera(page)
  await setStub(page, true)
  await expect(camera.getByRole('status')).toHaveText(
    'Câmera disponível. A imagem não inicia sozinha porque o movimento reduzido está ativado.',
  )
  expect(await source(page)).toBeNull()
  await expect(camera.locator('video')).toBeHidden()
  expect(await violations(page)).toEqual([])
  await camera.getByRole('button', { name: 'Mostrar imagem ao vivo' }).click()
  await expect(camera.getByRole('status')).toHaveText('Câmera ao vivo.')
  expect(await violations(page)).toEqual([])
})
