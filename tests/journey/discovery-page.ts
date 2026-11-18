// Shared journey steps: the Impressoras page finds the simulated printer
// through the Connector's own search, and the farm page shows its decoded
// camera frames. Both only drive the page; nothing calls a simulator.
import { expect, type Page } from '@playwright/test'
import { assertCameraPlaying } from '../helpers/signalling-farm-camera.ts'
import type { JourneyHarness } from './harness.ts'

type Family = 'creality-native' | 'anycubic-lan'

/**
 * Searches printers on the Impressoras page with the configuration Connector,
 * selects the found printer and returns once the family and address of the
 * set-up form are prefilled from the result.
 */
export async function discoverOnPage(
  journey: JourneyHarness,
  expected: Readonly<{
    family: Family
    /** Result label as the page prints it (model or vendor name). */
    label: string
    /** Id of the address field the prefill fills. */
    hostField: string
  }>,
  page: Page = journey.ownerPage,
) {
  const connector = journey.configurator
  if (!connector) throw new Error('Start the harness with discovery: true')
  // What the page saw, for the failure message only.
  const seen: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      seen.push(`console ${m.type()}: ${m.text().slice(0, 300)}`)
  })
  page.on('response', (r) => {
    if (r.url().includes('/api/configuration-authority/'))
      seen.push(`${r.status()} ${new URL(r.url()).pathname}`)
  })
  await page.goto(journey.origin + '/impressoras', {
    waitUntil: 'domcontentloaded',
  })
  const farm = page.getByLabel('Farm', { exact: true })
  await expect(farm).toBeVisible({ timeout: 30_000 })
  if ((await farm.inputValue()) !== journey.farmId)
    await farm.selectOption(journey.farmId)
  // The page offers every approved Connector; search runs on the one in
  // configuration mode.
  const select = page.locator('#kobra-connector')
  await expect(
    select.locator(`option[value="${connector.agentId}"]`),
  ).toBeAttached({ timeout: 30_000 })
  await select.selectOption(connector.agentId)
  // The configuration Connector announces config-v1 once its signalling is up;
  // the operator asks again with "Verificar capacidade do Connector".
  const ready = page.getByText(/Connector apto \(protocolo/)
  const verify = page.getByRole('button', {
    name: 'Verificar capacidade do Connector',
    exact: true,
  })
  try {
    await expect(async () => {
      if (!(await ready.isVisible())) {
        await expect(verify).toBeEnabled({ timeout: 5000 })
        await verify.click()
      }
      await expect(ready).toBeVisible({ timeout: 10_000 })
    }).toPass({ timeout: 150_000 })
  } catch (error) {
    throw new Error(
      `Connector capability not announced. Configurator output: ${connector.log()}`,
      { cause: error },
    )
  }

  // Start from another family so the prefill is what changes the form.
  const family = page.locator('#onboarding-family')
  await family.selectOption('bambu-lan')
  const search = page.getByRole('button', {
    name: 'Procurar impressoras',
    exact: true,
  })
  const result = page.getByRole('listitem').filter({ hasText: expected.label })
  const message = page.getByRole('status').filter({
    hasText: /encontrada|Não foi possível procurar|Nenhuma impressora/,
  })
  // A search that lands between two inbox leases of the Connector is refused
  // before anything runs; the operator tries again, and so does the journey.
  for (let attempt = 1; ; attempt++) {
    await expect(search).toBeEnabled({ timeout: 60_000 })
    await search.click()
    await expect(message).toHaveText(/./, { timeout: 60_000 })
    if ((await result.count()) > 0) break
    await page.waitForTimeout(2000)
    expect(
      attempt,
      `${(await message.textContent()) ?? ''} Configurator output: ${connector.log()} Page: ${seen.join(' | ')}`,
    ).toBeLessThan(12)
  }
  await expect(result).toHaveCount(1)
  await expect(result).toContainText('127.0.0.1')
  await expect(message).toHaveText('1 impressora(s) encontrada(s).')

  // The button names the printer by its name or, without one, its address.
  await result.getByRole('button', { name: /^Selecionar / }).click()
  await expect(family).toHaveValue(expected.family)
  await expect(page.locator('#' + expected.hostField)).toHaveValue('127.0.0.1')
}

/**
 * The farm page (already open) shows the printer's camera: the Connector
 * reads the vendor stream, the browser decodes it and the decoded frame count
 * keeps rising; stopping and showing the image again works (WCAG 2.2.2).
 */
export async function expectCameraFrames(
  journey: JourneyHarness,
  note: (value: string) => Promise<void> = async () => {},
) {
  const camera = journey.camera
  if (!camera) throw new Error('The simulator has no camera')
  await assertCameraPlaying({
    page: journey.ownerPage,
    printerKey: journey.printerKey,
    helperPath: camera.helper,
    note,
  })
  // The frames came from the simulated camera, not from a stand-in.
  expect(camera.requests()).toBeGreaterThan(0)
}
