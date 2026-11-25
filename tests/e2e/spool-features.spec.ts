import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Browser E2E tests for the farm-linked /bobinas pages (slots, usage and cost,
// low stock, drying and humidity, QR labels, reports) against the real Nuxt app
// served by tests/e2e/e2e-web-server.mjs. Every /api endpoint is mocked
// in-memory through Playwright route interception; non-loopback requests are
// aborted, so there is no Spoolman, printer or database.
const FARM_ID = '00000000-0000-4000-8000-000000000539'
const PRINTER_A = '11111111-1111-4111-8111-111111111111'
const PRINTER_B = '22222222-2222-4222-8222-222222222222'

interface Assignment {
  id: string
  spoolId: number
  printerId: string
  slotKind: 'printer' | 'ams' | 'toolhead'
  slotIndex: number
  assignedAt: number
  unassignedAt: number | null
}
interface Usage {
  id: string
  spoolId: number
  jobId: number | null
  printerId: string | null
  grams: number
  source: string
  correctedBy: string | null
  createdAt: number
  cost: number | null
}
interface Drying {
  id: string
  spoolId: number
  startedAt: number
  endedAt: number | null
  temperatureCelsius: number
  notes: string | null
}
interface Humidity {
  id: string
  spoolId: number | null
  printerId: string | null
  slotKind: string | null
  slotIndex: number | null
  humidityPercent: number
  source: 'manual' | 'ams'
  recordedAt: number
}

function filament(id: number, name: string, material: string, price: number) {
  return {
    id,
    registered: '2026-11-18T11:00:00Z',
    name,
    material,
    density: 1.24,
    diameter: 1.75,
    weight: 1000,
    price,
    color_hex: id === 1 ? '1C1F26' : 'E85D04',
    extra: {},
  }
}

function spool(id: number, fil: ReturnType<typeof filament>, used: number) {
  return {
    id,
    registered: '2026-11-18T12:00:00Z',
    filament: fil,
    initial_weight: 1000,
    spool_weight: 200,
    used_weight: used,
    remaining_weight: 1000 - used,
    remaining_length: 100000,
    used_length: 1000,
    location: `Estante ${id}`,
    archived: false,
    extra: {},
  }
}

async function installMockFeatures(
  page: Page,
  options: {
    role?: 'owner' | 'operator' | 'viewer'
    denyThresholdUpdate?: boolean
  } = {},
) {
  const role = options.role ?? 'owner'
  const access =
    role === 'owner' ? 'manage' : role === 'operator' ? 'write' : 'read'
  const canWrite = access !== 'read'
  const base = new Date('2026-11-20T12:00:00Z').getTime()

  const fil1 = filament(1, 'Galaxy Black', 'PLA', 200)
  const fil2 = filament(2, 'Laranja Sinal', 'PETG', 150)
  const spools = [spool(1, fil1, 300), spool(2, fil2, 850)]
  const printers = [
    { assignmentId: PRINTER_A, printerKey: 'ender-01', status: 'active' },
    { assignmentId: PRINTER_B, printerKey: 'voron-02', status: 'active' },
  ]

  const assignments: Assignment[] = []
  const usage: Usage[] = [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      spoolId: 1,
      jobId: 101,
      printerId: PRINTER_A,
      grams: 50,
      source: 'telemetry',
      correctedBy: null,
      createdAt: base,
      cost: 10,
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      spoolId: 2,
      jobId: 102,
      printerId: PRINTER_B,
      grams: 100,
      source: 'telemetry',
      correctedBy: null,
      createdAt: base + 3_600_000,
      cost: 15,
    },
  ]
  let defaultThreshold: number | null = null
  const thresholds = new Map<number, number | null>()
  const drying: Drying[] = []
  const humidity: Humidity[] = [
    {
      id: 'h1',
      spoolId: 1,
      printerId: null,
      slotKind: null,
      slotIndex: null,
      humidityPercent: 40,
      source: 'manual',
      recordedAt: base,
    },
    {
      id: 'h2',
      spoolId: 1,
      printerId: null,
      slotKind: null,
      slotIndex: null,
      humidityPercent: 22,
      source: 'manual',
      recordedAt: base + 86_400_000,
    },
  ]
  const calls = {
    assign: [] as Record<string, unknown>[],
    unassign: [] as Record<string, unknown>[],
    correct: [] as { id: string; body: Record<string, unknown> }[],
    settings: [] as Record<string, unknown>[],
    threshold: [] as { id: number; body: Record<string, unknown> }[],
    drying: [] as Record<string, unknown>[],
    dryingEnd: [] as Record<string, unknown>[],
    humidity: [] as Record<string, unknown>[],
    usageQueries: [] as string[],
  }

  function stock() {
    return [fil1, fil2].map((f) => {
      const remaining = spools
        .filter((s) => s.filament.id === f.id)
        .reduce((sum, s) => sum + s.remaining_weight, 0)
      const own = thresholds.get(f.id) ?? null
      const effective = own ?? defaultThreshold
      return {
        filamentId: f.id,
        name: f.name,
        material: f.material,
        remainingGrams: remaining,
        thresholdGrams: own,
        effectiveThresholdGrams: effective,
        low: effective !== null && remaining <= effective,
      }
    })
  }

  const fulfillJson = (
    route: Parameters<Parameters<Page['route']>[1]>[0],
    json: unknown,
    status = 200,
  ) => route.fulfill({ status, json })

  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: {} }),
  )
  await page.route('**/api/auth/me', (route) =>
    fulfillJson(route, { accountId: 'conta-bobinas' }),
  )
  await page.route('**/api/farms?*', (route) =>
    fulfillJson(route, { farms: [{ farmId: FARM_ID }], nextAfter: null }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    fulfillJson(route, {
      currentAccountId: 'conta-bobinas',
      currentRole: role,
      devices: [],
      nextAfter: null,
    }),
  )
  await page.route(`**/api/farms/${FARM_ID}/printers?*`, (route) =>
    fulfillJson(route, { printers, nextAfter: null, canManage: canWrite }),
  )
  await page.route(
    new RegExp(`/api/farms/${FARM_ID}/spool-library/spools(?:\\?|$)`),
    (route) =>
      fulfillJson(route, {
        items: spools,
        total: spools.length,
        access,
        canWrite,
        canImport: access === 'manage',
      }),
  )

  const lib = (path: string) =>
    new RegExp(`/api/farms/${FARM_ID}/spool-library/${path}`)

  await page.route(lib('slots(?:\\?|$)'), async (route) => {
    const req = route.request()
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>
      calls.assign.push(body)
      for (const item of assignments)
        if (
          item.unassignedAt === null &&
          (item.spoolId === body.spoolId ||
            (item.printerId === body.printerId &&
              item.slotKind === body.slotKind &&
              item.slotIndex === body.slotIndex))
        )
          item.unassignedAt = base
      const created: Assignment = {
        id: `slot-${assignments.length + 1}`,
        spoolId: body.spoolId as number,
        printerId: body.printerId as string,
        slotKind: body.slotKind as Assignment['slotKind'],
        slotIndex: body.slotIndex as number,
        assignedAt: base,
        unassignedAt: null,
      }
      assignments.push(created)
      return fulfillJson(route, { assignment: created })
    }
    return fulfillJson(route, { assignments })
  })
  await page.route(lib('slots/unassign'), (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    calls.unassign.push(body)
    for (const item of assignments)
      if (
        item.unassignedAt === null &&
        item.printerId === body.printerId &&
        item.slotKind === body.slotKind &&
        item.slotIndex === body.slotIndex
      )
        item.unassignedAt = base
    return fulfillJson(route, { unassigned: true })
  })

  function filtered(url: URL) {
    const printerId = url.searchParams.get('printerId')
    const spoolId = url.searchParams.get('spoolId')
    const jobId = url.searchParams.get('jobId')
    return usage.filter(
      (u) =>
        (!printerId || u.printerId === printerId) &&
        (!spoolId || String(u.spoolId) === spoolId) &&
        (!jobId || String(u.jobId) === jobId),
    )
  }
  await page.route(lib('usage(?:\\?|$)'), async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() === 'POST') return fulfillJson(route, { id: 'new' }, 201)
    calls.usageQueries.push(url.search)
    return fulfillJson(route, { currency: 'BRL', records: filtered(url) })
  })
  await page.route(lib('usage/([0-9a-f-]+)$'), (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!
    const body = route.request().postDataJSON() as { grams: number }
    calls.correct.push({ id, body })
    const record = usage.find((u) => u.id === id)
    if (!record) return fulfillJson(route, { message: 'Não encontrado.' }, 404)
    const previous = record.grams
    const spoolRow = spools.find((s) => s.id === record.spoolId)!
    spoolRow.used_weight += body.grams - previous
    spoolRow.remaining_weight -= body.grams - previous
    if (record.cost !== null)
      record.cost = (record.cost / previous) * body.grams
    record.grams = body.grams
    record.correctedBy = 'conta-bobinas'
    return fulfillJson(route, {
      id,
      previousGrams: previous,
      grams: body.grams,
    })
  })
  await page.route(lib('reports/usage'), (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('format') === 'csv')
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="usage-by-${url.searchParams.get('groupBy')}.csv"`,
        },
        body: 'jobId,records,grams,cost,unpricedRecords,currency\n',
      })
    const groupBy = url.searchParams.get('groupBy') ?? 'filament'
    const rows = filtered(url).map((u) =>
      groupBy === 'printer'
        ? {
            printerId: u.printerId,
            printerKey: u.printerId === PRINTER_A ? 'ender-01' : 'voron-02',
            records: 1,
            grams: u.grams,
            cost: u.cost,
            unpricedRecords: 0,
          }
        : {
            jobId: u.jobId,
            records: 1,
            grams: u.grams,
            cost: u.cost,
            unpricedRecords: 0,
          },
    )
    return fulfillJson(route, { currency: 'BRL', groupBy, rows })
  })
  await page.route(lib('reports/inventory'), (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('format') === 'csv')
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${url.searchParams.get('view') === 'low-stock' ? 'low-stock' : 'inventory'}.csv"`,
        },
        body: 'material,spools\n',
      })
    return fulfillJson(route, {
      currency: 'BRL',
      generatedAt: base,
      groups: [
        {
          material: 'PLA',
          location: 'Estante 1',
          spools: 1,
          remainingGrams: 700,
          remainingValue: 140,
        },
        {
          material: 'PETG',
          location: 'Estante 2',
          spools: 1,
          remainingGrams: 150,
          remainingValue: 22.5,
        },
      ],
      lowStock: stock().filter((s) => s.low),
    })
  })

  await page.route(lib('low-stock(?:\\?|$)'), (route) =>
    fulfillJson(route, {
      defaultLowStockThresholdGrams: defaultThreshold,
      currency: 'BRL',
      filaments: stock(),
    }),
  )
  await page.route(lib('low-stock/settings'), (route) => {
    if (options.denyThresholdUpdate || access !== 'manage')
      return fulfillJson(route, { message: 'Sem permissão.' }, 403)
    const body = route.request().postDataJSON() as {
      defaultLowStockThresholdGrams: number | null
    }
    calls.settings.push(body)
    defaultThreshold = body.defaultLowStockThresholdGrams
    return fulfillJson(route, {
      defaultLowStockThresholdGrams: defaultThreshold,
      currency: 'BRL',
    })
  })
  await page.route(lib('low-stock/filaments/(\\d+)$'), (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop())
    const body = route.request().postDataJSON() as {
      thresholdGrams: number | null
    }
    calls.threshold.push({ id, body })
    thresholds.set(id, body.thresholdGrams)
    return fulfillJson(route, { filamentId: id, ...body })
  })

  await page.route(lib('drying(?:\\?|$)'), (route) => {
    const req = route.request()
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Omit<Drying, 'id'>
      calls.drying.push(body)
      drying.unshift({ id: `d${drying.length + 1}`, ...body })
      return fulfillJson(route, { id: `d${drying.length}` })
    }
    const spoolId = Number(new URL(req.url()).searchParams.get('spoolId'))
    return fulfillJson(
      route,
      drying.filter((d) => d.spoolId === spoolId),
    )
  })
  await page.route(lib('drying/end'), (route) => {
    const body = route.request().postDataJSON() as {
      id: string
      endedAt: number
    }
    calls.dryingEnd.push(body)
    const log = drying.find((d) => d.id === body.id)
    if (log) log.endedAt = body.endedAt
    return fulfillJson(route, { id: body.id })
  })
  await page.route(lib('humidity(?:\\?|$)'), (route) => {
    const req = route.request()
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>
      calls.humidity.push(body)
      humidity.unshift({
        id: `h${humidity.length + 1}`,
        printerId: null,
        slotKind: null,
        slotIndex: null,
        ...body,
      } as Humidity)
      return fulfillJson(route, { id: 'new' })
    }
    const spoolId = Number(new URL(req.url()).searchParams.get('spoolId'))
    return fulfillJson(
      route,
      humidity
        .filter((h) => h.spoolId === spoolId)
        .sort((a, b) => b.recordedAt - a.recordedAt),
    )
  })
  await page.context().route(lib('labels(?:\\?|$)'), (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><title>Etiquetas de carretéis</title><p>Carretel #1</p>',
    }),
  )

  return { calls, usage, assignments }
}

async function waitHydrated(page: Page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
}

async function open(page: Page, path: string) {
  await page.goto(path)
  await waitHydrated(page)
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0)
}

function toast(page: Page) {
  return page.locator('main .toast')
}

async function assertAxeClean(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(
    violations
      .filter(({ impact }) => impact === 'serious' || impact === 'critical')
      .map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
    label,
  ).toEqual([])
}

test('operator assigns a spool to an AMS slot, moves it, and removes it', async ({
  page,
}) => {
  const mock = await installMockFeatures(page, { role: 'operator' })
  await open(page, '/bobinas/slots')

  const nav = page.getByRole('navigation', {
    name: 'Seções da biblioteca de bobinas',
  })
  await expect(nav.getByRole('link', { name: 'Slots' })).toHaveAttribute(
    'aria-current',
    'page',
  )

  const ender = page.getByRole('form', { name: 'Atribuir bobina a ender-01' })
  await ender.getByLabel('Tipo de slot').selectOption('ams')
  await ender.getByLabel('Número do slot').fill('2')
  await ender.getByLabel('Bobina').selectOption({ label: '#1 · Galaxy Black' })
  await ender.getByRole('button', { name: 'Atribuir' }).click()

  await expect(toast(page)).toContainText(
    'Bobina #1 atribuída a ender-01 (AMS 2).',
  )
  expect(mock.calls.assign).toEqual([
    { spoolId: 1, printerId: PRINTER_A, slotKind: 'ams', slotIndex: 1 },
  ])
  const list = page.getByRole('list', { name: 'Slots ativos de ender-01' })
  await expect(list).toContainText('AMS 2')
  await expect(list).toContainText('#1 · Galaxy Black')
  await expect(
    list.getByRole('img', { name: 'Nível restante: 70%' }),
  ).toBeVisible()

  // The same spool assigned to another printer moves out of the first one.
  const voron = page.getByRole('form', { name: 'Atribuir bobina a voron-02' })
  await voron.getByLabel('Tipo de slot').selectOption('toolhead')
  await voron.getByLabel('Número do slot').fill('1')
  await voron.getByLabel('Bobina').selectOption({ label: '#1 · Galaxy Black' })
  await voron.getByRole('button', { name: 'Atribuir' }).click()
  await expect(
    page.getByRole('list', { name: 'Slots ativos de voron-02' }),
  ).toContainText('Cabeçote 1')
  await expect(
    page.getByText('Nenhuma bobina atribuída a esta impressora.'),
  ).toBeVisible()

  await page
    .getByRole('button', {
      name: 'Remover bobina #1 de voron-02, Cabeçote 1',
    })
    .click()
  await expect(toast(page)).toContainText('removida de voron-02')
  expect(mock.calls.unassign).toEqual([
    { printerId: PRINTER_B, slotKind: 'toolhead', slotIndex: 0 },
  ])
})

test('usage shows per job and per printer cost, filters, and corrects a record', async ({
  page,
}) => {
  const mock = await installMockFeatures(page, { role: 'operator' })
  await open(page, '/bobinas/uso')

  const summary = page.getByRole('region', {
    name: /Resumo por trabalho/i,
  })
  await expect(summary).toContainText('Trabalho #101')
  await expect(summary).toContainText('50 g')
  await expect(summary).toContainText('R$')

  await page.getByLabel('Agrupar resumo').selectOption('printer')
  await page.getByRole('button', { name: 'Aplicar' }).click()
  await expect(
    page.getByRole('region', { name: /Resumo por impressora/i }),
  ).toContainText('voron-02')

  await page
    .getByRole('combobox', { name: /^Impressora/ })
    .selectOption(PRINTER_A)
  await page.getByRole('button', { name: 'Aplicar' }).click()
  await expect(toast(page)).toContainText('Uso atualizado.')
  const records = page.getByRole('region', {
    name: 'Registros de uso de filamento',
  })
  await expect(records.getByRole('row')).toHaveCount(2)
  await expect(records).toContainText('Telemetria')
  expect(mock.calls.usageQueries.at(-1)).toContain(`printerId=${PRINTER_A}`)

  await records
    .getByRole('button', { name: /Corrigir consumo de 50 g da bobina #1/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Corrigir consumo' })
  await dialog.getByLabel('Gramas usadas').fill('abc')
  await dialog.getByRole('button', { name: 'Salvar correção' }).click()
  await expect(dialog.getByRole('alert')).toContainText('número válido')

  await dialog.getByLabel('Gramas usadas').fill('75,5')
  await dialog.getByRole('button', { name: 'Salvar correção' }).click()
  await expect(dialog).toBeHidden()
  expect(mock.calls.correct).toEqual([
    { id: mock.usage[0]!.id, body: { grams: 75.5 } },
  ])
  await expect(records).toContainText('75,5 g')
  await expect(records).toContainText('(corrigido)')
})

test('owner sees low-stock items, sets a farm default and a per-filament threshold', async ({
  page,
}) => {
  const mock = await installMockFeatures(page, { role: 'owner' })
  await open(page, '/bobinas/estoque')

  await expect(
    page.getByText('Nenhum filamento com estoque baixo.'),
  ).toBeVisible()

  await page.getByLabel('Limite padrão (g)').fill('200')
  await page.getByRole('button', { name: 'Salvar limite padrão' }).click()
  await expect(toast(page)).toContainText('Limite padrão definido em 200 g.')
  expect(mock.calls.settings).toEqual([{ defaultLowStockThresholdGrams: 200 }])

  // Laranja Sinal has 150 g left, under the 200 g default.
  const alerts = page.getByRole('list', { name: 'Estoque baixo' })
  await expect(alerts).toContainText('Laranja Sinal')
  await expect(alerts).toContainText('restam 150 g')
  await expect(
    page.getByText('1 filamento(s) com estoque baixo.'),
  ).toBeVisible()
  await expect(
    alerts.getByRole('link', { name: 'Repor Laranja Sinal · PETG' }),
  ).toHaveAttribute('href', /\/bobinas\/filamentos/)

  await page
    .getByLabel('Limite em gramas para Laranja Sinal · PETG')
    .fill('100')
  await page
    .getByRole('button', { name: 'Salvar limite de Laranja Sinal · PETG' })
    .click()
  expect(mock.calls.threshold).toEqual([
    { id: 2, body: { thresholdGrams: 100 } },
  ])
  await expect(
    page.getByText('Nenhum filamento com estoque baixo.'),
  ).toBeVisible()

  await page.getByLabel('Limite padrão (g)').fill('lixo')
  await page.getByRole('button', { name: 'Salvar limite padrão' }).click()
  await expect(page.getByRole('alert')).toContainText('número válido')

  const csv = page.getByRole('link', { name: 'Baixar CSV de estoque baixo' })
  await expect(csv).toHaveAttribute(
    'href',
    `/api/farms/${FARM_ID}/spool-library/reports/inventory?format=csv&view=low-stock`,
  )
})

test('operator logs drying sessions and humidity and reads the history', async ({
  page,
}) => {
  const mock = await installMockFeatures(page, { role: 'operator' })
  await open(page, '/bobinas/secagem')

  await expect(
    page.getByText('Escolha uma bobina para ver e registrar secagem'),
  ).toBeVisible()
  await page
    .getByLabel('Escolha a bobina')
    .selectOption({ label: '#1 · Galaxy Black' })

  // Humidity history already holds two readings and a chart.
  const readings = page.getByRole('region', {
    name: 'Leituras de umidade da bobina #1',
  })
  await expect(readings.getByRole('row')).toHaveCount(3)
  await expect(readings).toContainText('22%')
  await expect(
    page.getByRole('img', { name: /Gráfico de umidade/ }),
  ).toBeVisible()

  const humidityForm = page.getByRole('form', { name: 'Registrar umidade' })
  await humidityForm.getByLabel('Umidade (%)').fill('130')
  await humidityForm.getByRole('button', { name: 'Registrar umidade' }).click()
  await expect(page.getByRole('alert')).toContainText('entre 0 e 100')
  await humidityForm.getByLabel('Umidade (%)').fill('18,5')
  await humidityForm.getByRole('button', { name: 'Registrar umidade' }).click()
  await expect(readings.getByRole('row')).toHaveCount(4)
  expect(mock.calls.humidity).toHaveLength(1)
  expect(mock.calls.humidity[0]).toMatchObject({
    spoolId: 1,
    humidityPercent: 18.5,
    source: 'manual',
  })

  await expect(page.getByText('Nenhuma secagem registrada')).toBeVisible()
  const dryingForm = page.getByRole('form', { name: 'Registrar secagem' })
  await dryingForm.getByLabel('Início').fill('2026-11-21T08:00')
  await dryingForm.getByLabel('Temperatura (°C)').fill('55')
  await dryingForm.getByLabel('Observações').fill('Drybox 2')
  await dryingForm.getByRole('button', { name: 'Registrar secagem' }).click()
  const sessions = page.getByRole('region', {
    name: 'Secagens da bobina #1',
  })
  await expect(sessions).toContainText('Em andamento')
  await expect(sessions).toContainText('55 °C')
  await expect(sessions).toContainText('Drybox 2')
  expect(mock.calls.drying[0]).toMatchObject({
    spoolId: 1,
    endedAt: null,
    temperatureCelsius: 55,
    notes: 'Drybox 2',
  })

  await sessions.getByRole('button', { name: /Encerrar secagem/ }).click()
  await expect(sessions).not.toContainText('Em andamento')
  expect(mock.calls.dryingEnd).toHaveLength(1)
})

test('QR labels link opens the label sheet for the selected spools and reports download CSV', async ({
  page,
}) => {
  await installMockFeatures(page, { role: 'owner' })
  await open(page, '/bobinas/etiquetas')

  await expect(page.getByText('Selecione ao menos uma bobina.')).toBeVisible()
  await page.getByLabel('#2 · Laranja Sinal').check()
  await page.getByLabel('#1 · Galaxy Black').check()
  const link = page.getByRole('link', { name: 'Abrir etiquetas (2)' })
  await expect(link).toHaveAttribute(
    'href',
    `/api/farms/${FARM_ID}/spool-library/labels?spoolIds=1,2`,
  )
  await expect(link).toHaveAttribute('target', '_blank')
  const popup = page.waitForEvent('popup')
  await link.click()
  const labels = await popup
  await expect(labels.locator('p')).toHaveText('Carretel #1')

  await page.getByRole('button', { name: 'Limpar seleção' }).click()
  await expect(page.getByText('Selecione ao menos uma bobina.')).toBeVisible()

  await open(page, '/bobinas/relatorios')
  const inventory = page.getByRole('region', {
    name: 'Inventário por material e localização',
  })
  await expect(inventory).toContainText('PETG')
  await expect(inventory).toContainText('Estante 2')

  const inventoryDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Inventário (CSV)' }).click()
  // The browser's download manager bypasses route mocks, so assert the request
  // the page starts (the CSV endpoint) rather than the mocked file name.
  expect(new URL((await inventoryDownload).url()).pathname).toBe(
    `/api/farms/${FARM_ID}/spool-library/reports/inventory`,
  )

  const usageDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Uso por impressora (CSV)' }).click()
  const usageUrl = new URL((await usageDownload).url())
  expect(usageUrl.pathname).toBe(
    `/api/farms/${FARM_ID}/spool-library/reports/usage`,
  )
  expect(usageUrl.search).toBe('?groupBy=printer&format=csv')
})

test('viewer gets a read-only view without write controls', async ({
  page,
}) => {
  await installMockFeatures(page, { role: 'viewer' })
  await open(page, '/bobinas/slots')
  await expect(page.getByText('Modo somente leitura')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Atribuir' })).toHaveCount(0)

  await open(page, '/bobinas/uso')
  await expect(page.getByRole('button', { name: /Corrigir/ })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Registrar consumo manual' }),
  ).toHaveCount(0)

  await open(page, '/bobinas/estoque')
  await expect(page.getByLabel('Limite padrão (g)')).toHaveCount(0)
  await expect(page.getByText('Somente leitura.')).toBeVisible()

  await open(page, '/bobinas/secagem')
  await page
    .getByLabel('Escolha a bobina')
    .selectOption({ label: '#1 · Galaxy Black' })
  await expect(
    page.getByRole('form', { name: 'Registrar secagem' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: /Leituras de umidade/ }),
  ).toBeVisible()
})

test('a permission error from the server is shown instead of silently failing', async ({
  page,
}) => {
  await installMockFeatures(page, { role: 'owner', denyThresholdUpdate: true })
  await open(page, '/bobinas/estoque')
  await page.getByLabel('Limite padrão (g)').fill('100')
  await page.getByRole('button', { name: 'Salvar limite padrão' }).click()
  await expect(page.getByRole('alert')).toContainText('Sem permissão.')
})

test('keyboard users can reach and operate the slot form in order', async ({
  page,
}) => {
  await installMockFeatures(page, { role: 'operator' })
  await open(page, '/bobinas/slots')
  const form = page.getByRole('form', { name: 'Atribuir bobina a ender-01' })
  await form.getByLabel('Tipo de slot').focus()
  await page.keyboard.press('Tab')
  await expect(form.getByLabel('Número do slot')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(form.getByLabel('Bobina')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(form.getByRole('button', { name: 'Atribuir' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText('Escolha uma bobina')
})

test('all new /bobinas pages are axe-clean and fit at phone and desktop widths in light and dark themes', async ({
  page,
}) => {
  test.setTimeout(300_000)
  await installMockFeatures(page, { role: 'owner' })
  const paths = [
    '/bobinas/slots',
    '/bobinas/localizar',
    '/bobinas/uso',
    '/bobinas/estoque',
    '/bobinas/secagem',
    '/bobinas/etiquetas',
    '/bobinas/relatorios',
  ]
  for (const width of [360, 1280]) {
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/bobinas/slots')
      await page.evaluate(
        (value) => localStorage.setItem('farm-theme', value),
        theme,
      )
      for (const path of paths) {
        await page.goto(path)
        await waitHydrated(page)
        await expect(page.locator('main')).toBeVisible()
        await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0)
        if (path === '/bobinas/secagem')
          await page
            .getByLabel('Escolha a bobina')
            .selectOption({ label: '#1 · Galaxy Black' })
        if (path === '/bobinas/slots')
          await page
            .getByRole('form', { name: 'Atribuir bobina a ender-01' })
            .getByLabel('Bobina')
            .selectOption({ label: '#1 · Galaxy Black' })
        if (
          [
            '/bobinas/slots',
            '/bobinas/localizar',
            '/bobinas/uso',
            '/bobinas/secagem',
            '/bobinas/etiquetas',
          ].includes(path)
        )
          await expect(
            page.getByRole('img', { name: 'Nível restante: 70%' }),
          ).toBeVisible()
        await assertAxeClean(page, `${path} at ${width}px (${theme})`)
        const fits = await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        )
        expect(fits, `${path} horizontal overflow at ${width}px`).toBe(true)
      }
    }
  }
})
