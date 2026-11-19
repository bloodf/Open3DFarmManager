import { expect, test } from './fixtures.ts'
import type { MoonrakerSimulator } from '../../journey/moonraker-simulator.ts'

test('exibe saúde de enlace em mapa e tabela para dois Connectors, reflete latência injetada e adota impressora descoberta', async ({
  bootFarm,
}) => {
  const discoveredName = 'prusa-descoberta'
  const farm = await bootFarm({
    printers: [
      { family: 'moonraker', printerKey: 'c1-alpha', connector: 1, live: true },
      { family: 'moonraker', printerKey: 'c1-beta', connector: 1, live: true },
      { family: 'moonraker', printerKey: 'c2-alpha', connector: 2, live: true },
      { family: 'moonraker', printerKey: 'c2-beta', connector: 2, live: true },
    ],
    discoveredMoonraker: { name: discoveredName },
  })

  try {
    const page = farm.owner
    const targetPrinter = farm.printers.find(
      (printer) => printer.printerKey === 'c1-beta',
    )
    const targetMock = targetPrinter?.mock as MoonrakerSimulator | undefined
    if (!targetMock) throw new Error('Mock da impressora c1-beta ausente')
    if (farm.connectors.length !== 2)
      throw new Error('Dois Connectors são necessários para este cenário')
    if (!farm.discovered) throw new Error('Mock Moonraker descoberto ausente')

    const connectorLabels = farm.connectors.map(
      (agentId) => `Connector ${agentId.slice(0, 8)}`,
    )

    // 1. Ver saúde de enlace por impressora no mapa e na tabela da página /rede.
    const redeResponse = await page.goto(farm.origin + '/rede', {
      waitUntil: 'domcontentloaded',
    })
    expect(redeResponse?.status()).toBe(200)
    await expect(
      page.getByRole('heading', { name: 'Rede da farm', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText(
        'Dados ao vivo pela conexão direta do navegador com o Connector.',
      ),
    ).toBeVisible({ timeout: 60_000 })

    await page.getByRole('button', { name: 'Mapa', exact: true }).click()
    const mapSvg = page.locator('svg[aria-label^="Mapa da farm:"]')
    await expect(mapSvg).toBeVisible()

    for (const label of connectorLabels) {
      const node = mapSvg.locator('g.item').filter({ hasText: label })
      await expect(node).toBeVisible({ timeout: 30_000 })
      await expect(node.locator('.link-label')).toContainText('✓ Conectado', {
        timeout: 30_000,
      })
    }
    for (const { printerKey } of farm.printers) {
      const node = mapSvg.locator('g.item').filter({ hasText: printerKey })
      await expect(node).toBeVisible({ timeout: 30_000 })
      await expect(node.locator('.link-label')).toContainText(
        /✓ Conectado · \d+\s*ms/,
        { timeout: 30_000 },
      )
    }

    await page.getByRole('button', { name: 'Tabela', exact: true }).click()
    const table = page.locator('table')
    await expect(table).toBeVisible()
    for (const { printerKey, connector } of farm.printers) {
      const expectedConnector =
        connectorLabels[(connector ?? 1) - 1] ?? connectorLabels[0]!
      const row = table.locator('tbody tr').filter({ hasText: printerKey })
      await expect(row).toBeVisible()
      await expect(row).toContainText('Impressora')
      await expect(row).toContainText(expectedConnector)
      await expect(row).toContainText('✓ Conectado', { timeout: 30_000 })
      await expect(row.locator('td').nth(4)).toHaveText(
        /^\d+\s*ms \(p95 \d+\s*ms\)$/,
        { timeout: 30_000 },
      )
    }

    // 2. Injetar latência em c1-beta e verificar reflexo na tabela e no mapa.
    targetMock.control.faults.setFault({
      method: 'printer.objects.query',
      fault: { type: 'delay', delayMs: 250 },
    })
    try {
      const betaRow = table.locator('tbody tr').filter({ hasText: 'c1-beta' })
      await expect(betaRow.locator('td').nth(4)).toHaveText(
        /^(?:2\d\d|[3-9]\d\d|\d{4,})\s*ms \(p95 (?:2\d\d|[3-9]\d\d|\d{4,})\s*ms\)$/,
        { timeout: 60_000 },
      )

      await page.getByRole('button', { name: 'Mapa', exact: true }).click()
      const betaNode = mapSvg.locator('g.item').filter({ hasText: 'c1-beta' })
      await expect(betaNode.locator('.link-label')).toContainText(
        /✓ Conectado · (?:2\d\d|[3-9]\d\d|\d{4,})\s*ms/,
        { timeout: 15_000 },
      )
    } finally {
      targetMock.control.faults.clearFaults()
    }

    // 3. Procurar impressoras no Connector 2 e adotar o mock Moonraker descoberto.
    const connector2 = farm.connectors[1]!
    await page.locator('#rede-scan-connector').selectOption(connector2)
    await page
      .getByRole('button', { name: 'Procurar agora', exact: true })
      .click()

    const discoveredNode = mapSvg
      .locator('g.item')
      .filter({ hasText: discoveredName })
    await expect(discoveredNode).toBeVisible({ timeout: 30_000 })
    await expect(discoveredNode.locator('.link-label')).toContainText(
      '? Descoberta',
    )

    await page
      .getByRole('button', {
        name: new RegExp(`Adicionar à farm:.*${discoveredName}`),
      })
      .click()

    await page.waitForURL('**/impressoras')
    await expect(page.locator('#onboarding-family')).toHaveValue(
      'klipper-moonraker',
      { timeout: 15_000 },
    )
    await expect(page.locator('#moonraker-origin')).toHaveValue(
      farm.discovered.origin,
    )
    await expect(page.locator('#kobra-label')).toHaveValue(discoveredName)

    await page
      .getByRole('button', {
        name: 'Preparar Klipper / Moonraker',
        exact: true,
      })
      .click()
    const confirmCheckbox = page.locator('#kobra-confirm-checkbox')
    await expect(confirmCheckbox).toBeVisible({ timeout: 30_000 })
    await confirmCheckbox.check()
    await page
      .getByRole('button', {
        name: 'Confirmar e ativar impressora',
        exact: true,
      })
      .click()

    await expect(page.locator('#kobra-confirmed-heading')).toBeVisible({
      timeout: 30_000,
    })
    const adoptedKey = (
      await page
        .locator('dt:has-text("Chave canônica atribuída") + dd')
        .textContent()
    )?.trim()
    if (!adoptedKey)
      throw new Error('Chave canônica da impressora adotada ausente')

    // 4. Confirmar que a impressora adotada entrou na farm e aparece ativa em /rede.
    await farm.openFarm()
    for (const { printerKey } of farm.printers)
      await expect(farm.printerCard(printerKey)).toBeVisible()
    const adoptedCard = farm.printerCard(adoptedKey)
    await expect(adoptedCard).toBeVisible()
    await expect(
      adoptedCard.getByText('Conexão direta autenticada', { exact: true }),
    ).toBeVisible({ timeout: 60_000 })

    const redeAfterResponse = await page.goto(farm.origin + '/rede', {
      waitUntil: 'domcontentloaded',
    })
    expect(redeAfterResponse?.status()).toBe(200)
    await page.getByRole('button', { name: 'Tabela', exact: true }).click()
    const adoptedRow = page.locator('table tbody tr').filter({
      has: page.locator(
        `a[href="/impressoras/${encodeURIComponent(adoptedKey)}"]`,
      ),
    })
    await expect(adoptedRow).toBeVisible({ timeout: 30_000 })
    await expect(adoptedRow).toContainText('Impressora')
    await expect(adoptedRow).toContainText(connectorLabels[1]!)
    await expect(adoptedRow).toContainText('✓ Conectado', { timeout: 30_000 })
    await expect(
      page.locator('table tbody tr').filter({ hasText: 'Descoberta' }),
    ).toHaveCount(0)

    expect(farm.blockedRequests()).toEqual([])
    farm.assertNoOutbound()
  } catch (error) {
    console.error(farm.harness.appLog())
    if (farm.harness.configurator)
      console.error(farm.harness.configurator.log())
    throw error
  }
})
