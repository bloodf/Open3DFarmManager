import type { createCrealitySimulator } from '../../../packages/sim-tools/src/creality-simulator.ts'
import type { VendorSimulator } from '../../journey/harness.ts'
import type { KobraBridgeSimulator } from '../../journey/harness-kobralink-bridge.ts'
import type { MoonrakerSimulator } from '../../journey/moonraker-simulator.ts'
import { expect, test, type PrinterSeed } from './fixtures.ts'

type CrealityRaw = Awaited<ReturnType<typeof createCrealitySimulator>>

const SEEDS: readonly PrinterSeed[] = [
  // 8 Moonraker
  ...Array.from({ length: 8 }, (_, i) => ({
    family: 'moonraker' as const,
    printerKey: `wall-moon-${i + 1}`,
    displayName: `Bancada Moon ${String(i + 1).padStart(2, '0')}`,
    groupName: i % 2 === 0 ? 'Protótipos' : 'Produção',
    location: i < 4 ? 'Galpão A' : 'Sala B',
    sortOrder: i + 1,
  })),
  // 4 Bambu
  ...Array.from({ length: 4 }, (_, i) => ({
    family: 'bambu' as const,
    printerKey: `wall-bambu-${i + 1}`,
    displayName: `Bancada Bambu ${String(i + 1).padStart(2, '0')}`,
    groupName: i % 2 === 0 ? 'Protótipos' : 'Produção',
    location: i % 2 === 0 ? 'Galpão A' : 'Sala B',
    sortOrder: 10 + i,
  })),
  // 4 Creality
  ...Array.from({ length: 4 }, (_, i) => ({
    family: 'creality' as const,
    printerKey: `wall-creality-${i + 1}`,
    displayName: `Bancada Creality ${String(i + 1).padStart(2, '0')}`,
    groupName: i % 2 === 0 ? 'Protótipos' : 'Produção',
    location: i % 2 === 0 ? 'Galpão A' : 'Sala B',
    sortOrder: 20 + i,
  })),
  // 4 Anycubic
  ...Array.from({ length: 4 }, (_, i) => ({
    family: 'anycubic' as const,
    printerKey: `wall-anycubic-${i + 1}`,
    displayName: `Bancada Anycubic ${String(i + 1).padStart(2, '0')}`,
    groupName: i % 2 === 0 ? 'Protótipos' : 'Produção',
    location: i % 2 === 0 ? 'Galpão A' : 'Sala B',
    sortOrder: 30 + i,
  })),
  // 4 KobraLink
  ...Array.from({ length: 4 }, (_, i) => ({
    family: 'kobralink' as const,
    printerKey: `wall-kobra-${i + 1}`,
    displayName: `Bancada Kobra ${String(i + 1).padStart(2, '0')}`,
    groupName: i % 2 === 0 ? 'Protótipos' : 'Produção',
    location: i % 2 === 0 ? 'Galpão A' : 'Sala B',
    sortOrder: 40 + i,
  })),
]

test('mural de status com 24 impressoras mistas, alertas, filtros, tabela, painel 1080p e mobile 390px', async ({
  bootFarm,
}) => {
  const farm = await bootFarm({
    printers: SEEDS,
    connectAll: true,
  })
  const page = farm.owner

  try {
    // Descobre quais atribuições estão na 1ª página (ordem por UUID, limite 20)
    // para injetar estados determinísticos na página inicial sem flake de ordenação.
    const page1 = (await page.evaluate(async (farmId) => {
      const response = await fetch(`/api/farms/${farmId}/printers?limit=20`, {
        cache: 'no-store',
      })
      return response.json()
    }, farm.farmId)) as {
      printers: { printerKey: string; agentId: string }[]
    }
    const page1Keys = new Set(page1.printers.map((p) => p.printerKey))
    expect(page1.printers).toHaveLength(20)

    const findOnPage1 = (
      family: (typeof SEEDS)[number]['family'],
      excludeKeys: ReadonlySet<string> = new Set(),
    ) => {
      const match = farm.printers.find(
        (p) =>
          p.family === family &&
          page1Keys.has(p.printerKey) &&
          !excludeKeys.has(p.printerKey),
      )
      if (!match) throw new Error(`No ${family} printer landed on page 1`)
      return match
    }

    const used = new Set<string>()
    const errorPrinter = findOnPage1('moonraker', used)
    used.add(errorPrinter.printerKey)
    const pausedPrinter = findOnPage1('kobralink', used)
    used.add(pausedPrinter.printerKey)
    const idlePrinter = findOnPage1('moonraker', used)
    used.add(idlePrinter.printerKey)
    const lowSlotCreality = findOnPage1('creality', used)
    used.add(lowSlotCreality.printerKey)

    // Injeta erro, pausa, ociosa e filamento baixo (< 10%) nos mocks da página 1.
    ;(errorPrinter.mock as MoonrakerSimulator).update({ state: 'error' })
    ;(
      (pausedPrinter.mock as VendorSimulator).raw as KobraBridgeSimulator
    ).setState({
      printState: 'paused',
      progress: 0.45,
      filename: 'pausa-teste.gcode',
    })
    ;(idlePrinter.mock as MoonrakerSimulator).update({ state: 'standby' })

    const setLowFilament = () => {
      const crealityRaw = (lowSlotCreality.mock as VendorSimulator)
        .raw as CrealityRaw
      crealityRaw.setFrame({
        state: 1,
        err: 0,
        printProgress: 25,
        boxsInfo: {
          materialBoxs: [
            {
              id: 0,
              materials: [
                {
                  id: 0,
                  type: 'PLA',
                  color: '#0D9488',
                  percent: 7,
                  selected: 1,
                },
              ],
            },
          ],
        },
      })
    }
    setLowFilament()

    await farm.openFarm()

    // 1) Cartões e conexões ao vivo na 1ª página (20 impressoras)
    await expect(
      page.getByText('20 de 20 impressoras nesta página.'),
    ).toBeVisible()
    await expect(
      page.locator('.printer-card').getByText('Conexão direta autenticada'),
    ).toHaveCount(20, { timeout: 60_000 })

    // Garante que o snapshot de filamento baixo da Creality está ativo mesmo se o timer de 6 s concluir.
    setLowFilament()

    // 2) Alertas da farm e chips nos cartões: erro + filamento abaixo de 10%
    const alertsSection = page.getByRole('region', { name: 'Alertas da farm' })
    await expect(
      alertsSection.locator('[data-alert-kind="error"]').first(),
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      alertsSection.locator('[data-alert-kind="low-slot"]').first(),
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      alertsSection.getByText('Impressora em estado de erro.'),
    ).toBeVisible()
    await expect(
      alertsSection.getByText(/Filamento abaixo de 10%/).first(),
    ).toBeVisible()

    await expect(
      farm
        .printerCard(errorPrinter.printerKey)
        .locator('[data-alert-kind="error"]'),
    ).toBeVisible()
    await expect(
      farm
        .printerCard(lowSlotCreality.printerKey)
        .locator('[data-alert-kind="low-slot"]'),
    ).toBeVisible()

    // 3) Paginação até a 2ª página (24 impressoras no total: 20 + 4)
    await page.getByRole('button', { name: 'Próximas atribuições' }).click()
    await expect(
      page.getByText('Exibindo outra página de atribuições.'),
    ).toBeVisible()
    await expect(
      page.getByText('4 de 4 impressoras nesta página.'),
    ).toBeVisible()
    await expect(
      page.locator('.printer-card').getByText('Conexão direta autenticada'),
    ).toHaveCount(4, { timeout: 60_000 })
    await page
      .getByRole('button', { name: 'Primeira página de atribuições' })
      .click()
    await expect(
      page.getByText('20 de 20 impressoras nesta página.'),
    ).toBeVisible()
    await expect(
      page.locator('.printer-card').getByText('Conexão direta autenticada'),
    ).toHaveCount(20, { timeout: 60_000 })
    setLowFilament()

    // 4) Filtros e agrupamento
    await page
      .getByLabel('Buscar impressora, Connector ou atribuição')
      .fill(errorPrinter.printerKey)
    await expect(
      page.getByText('1 de 20 impressoras nesta página.'),
    ).toBeVisible()
    await expect(farm.printerCard(errorPrinter.printerKey)).toBeVisible()

    await page.getByRole('button', { name: 'Limpar filtros' }).click()
    await expect(
      page.getByText('20 de 20 impressoras nesta página.'),
    ).toBeVisible()

    await page.getByLabel('Alertas de erro').selectOption('yes')
    await expect(farm.printerCard(errorPrinter.printerKey)).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.locator('.printer-card')).toHaveCount(1, {
      timeout: 15_000,
    })

    await page.getByRole('button', { name: 'Limpar filtros' }).click()
    await expect(
      page.getByText('20 de 20 impressoras nesta página.'),
    ).toBeVisible()
    await page
      .getByLabel('Filtrar por estado ou conexão')
      .selectOption('paused')
    await expect(farm.printerCard(pausedPrinter.printerKey)).toBeVisible({
      timeout: 15_000,
    })

    await page.getByRole('button', { name: 'Limpar filtros' }).click()
    await expect(
      page.getByText('20 de 20 impressoras nesta página.'),
    ).toBeVisible()
    const page1Seeds = SEEDS.filter((seed) => page1Keys.has(seed.printerKey!))
    const prototiposCount = page1Seeds.filter(
      (seed) => seed.groupName === 'Protótipos',
    ).length
    const prototiposGalpaoCount = page1Seeds.filter(
      (seed) => seed.groupName === 'Protótipos' && seed.location === 'Galpão A',
    ).length
    expect(prototiposCount).toBeGreaterThan(0)
    expect(prototiposCount).toBeLessThan(20)
    expect(prototiposGalpaoCount).toBeGreaterThan(0)
    expect(prototiposGalpaoCount).toBeLessThanOrEqual(prototiposCount)

    await page.getByLabel('Grupo').selectOption('Protótipos')
    await expect(page.locator('.printer-card')).toHaveCount(prototiposCount)

    await page.getByLabel('Local', { exact: true }).selectOption('Galpão A')
    await expect(page.locator('.printer-card')).toHaveCount(
      prototiposGalpaoCount,
    )

    await page.getByRole('button', { name: 'Limpar filtros' }).click()
    await expect(
      page.getByText('20 de 20 impressoras nesta página.'),
    ).toBeVisible()
    await page.getByLabel('Agrupar por').selectOption('groupName')
    await expect(
      page.getByRole('heading', { name: 'Protótipos', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Produção', exact: true }),
    ).toBeVisible()

    await page.getByLabel('Agrupar por').selectOption('location')
    await expect(
      page.getByRole('heading', { name: 'Galpão A', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Sala B', exact: true }),
    ).toBeVisible()
    await page.getByLabel('Agrupar por').selectOption('')

    // 5) Visualização em tabela, ordenação e detalhe
    await page.getByRole('button', { name: 'Tabela' }).click()
    const table = page.getByRole('table', { name: 'Impressoras atribuídas' })
    await expect(table).toBeVisible()
    await expect(table.locator('tbody tr')).toHaveCount(20)

    const errorSeed = SEEDS.find(
      (s) => s.printerKey === errorPrinter.printerKey,
    )!
    const errorRow = table.locator('tbody tr', {
      hasText: errorSeed.displayName!,
    })
    await expect(errorRow).toContainText('Erro na impressora', {
      timeout: 15_000,
    })

    const initialFirst = await table
      .locator('tbody tr th a')
      .first()
      .innerText()
    await table.getByRole('button', { name: 'Nome' }).click()
    await expect(
      table.getByRole('columnheader', { name: 'Nome' }),
    ).toHaveAttribute('aria-sort', 'descending')
    const descendingFirst = await table
      .locator('tbody tr th a')
      .first()
      .innerText()
    expect(descendingFirst).not.toBe(initialFirst)

    // Cada linha da tabela abre a página de detalhes da impressora
    await expect(errorRow.getByRole('link')).toHaveAttribute(
      'href',
      `/impressoras/${encodeURIComponent(errorPrinter.printerKey)}`,
    )
    await page.getByRole('button', { name: 'Cartões' }).click()
    await expect(farm.printerCard(errorPrinter.printerKey)).toBeVisible()
    await expect(table).toHaveCount(0)

    // 6) Página /farm em viewport mobile de 390 px (cartões e tabela sem estouro horizontal)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(
      page.getByRole('heading', { name: 'Minha farm', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Alertas da farm' }),
    ).toBeVisible()
    const cardsOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(cardsOverflow).toBeLessThanOrEqual(1)

    await page.getByRole('button', { name: 'Tabela' }).click()
    await expect(
      page.getByRole('region', { name: 'Tabela de impressoras' }),
    ).toBeVisible()
    const tableOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(tableOverflow).toBeLessThanOrEqual(1)

    await page.getByRole('button', { name: 'Cartões' }).click()

    // 7) Painel /painel em 1920x1080 exibindo todas as 24 impressoras em uma única tela, somente leitura
    farm.harness.setTelemetryUpload(true)

    await expect
      .poll(
        async () =>
          page.evaluate(async (farmId) => {
            const response = await fetch(
              `/api/farms/${farmId}/printer-states`,
              {
                cache: 'no-store',
              },
            )
            if (!response.ok) return 0
            const body = (await response.json()) as { states?: unknown[] }
            return body.states?.length ?? 0
          }, farm.farmId),
        { timeout: 30_000, intervals: [500, 1000, 1500] },
      )
      .toBe(24)

    await page.setViewportSize({ width: 1920, height: 1080 })
    const kioskResponse = await page.goto(farm.origin + '/painel', {
      waitUntil: 'domcontentloaded',
    })
    expect(kioskResponse?.status()).toBe(200)
    await expect(
      page.getByRole('heading', {
        name: 'Painel das impressoras',
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.locator('.kiosk__card')).toHaveCount(24, {
      timeout: 20_000,
    })
    await expect(page.getByText(/^Página \d+ de \d+$/)).toHaveCount(0)
    await expect(page.getByText('Painel indisponível')).toHaveCount(0)
    await expect(page.getByText(errorSeed.displayName!)).toBeVisible()
    await expect(page.getByText('Erro').first()).toBeVisible()

    // Somente leitura: nenhum botão, link ou campo no painel.
    expect(
      await page.locator('button, a, input, select, textarea').count(),
    ).toBe(0)

    expect(farm.blockedRequests()).toEqual([])
    farm.assertNoOutbound()
  } catch (error) {
    console.error(farm.harness.appLog())
    throw error
  }
})
