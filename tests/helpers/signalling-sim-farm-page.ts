import type { Page } from '@playwright/test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import type { ProvisionedSignallingFixture } from './signalling-https-fixture-contract.ts'
import { visibleWithinReadOnlyDeadline } from './read-only-deadline.ts'

const seed = JSON.parse(
  readFileSync(
    new URL('../../infra/sim/spoolman/seed.json', import.meta.url),
    'utf8',
  ),
) as { filaments: { name: string }[]; spools: unknown[] }

/**
 * Farm page against a genuine simulator: the generated page, its stored key and
 * the production feed, no API interception. Read-only: the pause button must
 * stay disabled and no command is sent.
 */
export async function testSimulatorFarmPage(input: {
  fixture: ProvisionedSignallingFixture
  mockOrigin?: string | undefined
  note(value: string): Promise<void>
}) {
  const { fixture } = input
  const assignment = fixture.assignmentRefs[0]
  assert.equal(fixture.assignmentRefs.length, 1)
  assert.ok(assignment)
  const page = await fixture.ownerContext.newPage()
  page.setDefaultTimeout(7500)
  const abort = () => {
    void page.close().catch(() => {})
  }
  fixture.signal.addEventListener('abort', abort, { once: true })
  try {
    if (input.mockOrigin)
      await page.setViewportSize({ width: 768, height: 1024 })
    const response = await page.goto(fixture.origin + '/farm', {
      waitUntil: 'domcontentloaded',
      timeout: 7500,
    })
    assert.equal(response?.status(), 200)
    await expect(page.getByLabel('Farm atual', { exact: true })).toHaveValue(
      fixture.farmId,
    )
    const row = page.getByRole('article').filter({
      has: page.getByRole('heading', {
        name: assignment.printerKey,
        exact: true,
      }),
    })
    await expect(
      row.getByText('Conexão direta autenticada', { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    // A genuine idle simulator: state and both observed temperatures.
    await expect(
      row.locator('dt:text-is("Último estado informado") + dd'),
    ).toHaveText('Ociosa')
    const temperatures = row.locator(
      'dl[aria-label="Temperaturas observadas"] dd',
    )
    await expect(temperatures).toHaveCount(2)
    const readings = await temperatures.allInnerTexts()
    for (const reading of readings) assert.match(reading, /^-?[\d.,]+ °C$/)
    await expect(
      row.getByRole('button', { name: /^Pausar(?: impressão)?$/ }),
    ).toBeDisabled()
    await input.note(
      'farm-page-simulator-observed:' +
        JSON.stringify({ state: 'Ociosa', temperatures: readings }),
    )
    // Spoolman inventory relayed by the Connector over the same channel.
    // The caption is interpolated across lines; match it whitespace-tolerantly.
    const table = page.getByRole('region', { name: /^Bobinas: / })
    const caption = table.locator('caption')
    await expect(caption).toHaveText(/Bobinas\s*\(\s*\d+\s+de\s+\d+\s*\)/, {
      timeout: 15000,
    })
    const [shown, total] = (await caption.innerText())
      .match(/\d+/g)!
      .map(Number)
    assert.equal(shown, seed.spools.length)
    assert.equal(total, seed.spools.length)
    for (const filament of seed.filaments)
      await expect(
        table.getByRole('rowheader', { name: filament.name, exact: true }),
      ).not.toHaveCount(0)
    await input.note(`farm-page-simulator-spools:${shown}/${total}`)
    if (input.mockOrigin) {
      const link = row.getByRole('link', { name: /^Abrir interface local de/ })
      const printer = new URL(input.mockOrigin)
      printer.port = ''
      await expect(link).toHaveAttribute('href', printer.origin)
      await input.note('farm-page-printer-ui-origin-link')
      await assertTabletGrid(page, '.printers')
      await input.note('farm-page-tablet-grid')
    }
    // Issue #8: read-only within 10 s of losing the direct connection.
    const closedAt = performance.now()
    await fixture.disconnectSignalling()
    const elapsed = await visibleWithinReadOnlyDeadline(closedAt, (timeout) =>
      expect(
        row.getByText(
          'Conexão direta indisponível. Exibindo a última observação.',
          { exact: true },
        ),
      ).toBeVisible({ timeout }),
    )
    await input.note(`farm-page-readonly-after-ms:${Math.round(elapsed)}`)
    await expect(
      row.getByRole('button', { name: /^Pausar(?: impressão)?$/ }),
    ).toBeDisabled()
    if (input.mockOrigin) {
      const printers = await page.goto(fixture.origin + '/impressoras', {
        waitUntil: 'domcontentloaded',
      })
      assert.equal(printers?.status(), 200)
      await expect(
        page.getByRole('heading', { name: 'Impressoras da farm', exact: true }),
      ).toBeVisible()
      await page
        .getByLabel('Farm', { exact: true })
        .selectOption(fixture.farmId)
      await assertTabletGrid(page, '.setup-columns')
      await input.note('printers-page-tablet-grid')
    }
    fixture.signal.throwIfAborted()
  } catch (error) {
    const text = await page
      .locator('main')
      .innerText({ timeout: 1000 })
      .catch(() => 'Page unavailable')
    const uuid = /[0-9a-f]{8}-[0-9a-f-]{27}/g
    await input.note(
      'farm-page-failure:' +
        JSON.stringify({
          // Locator and expectation only; page text is already sanitized.
          error: String(error instanceof Error ? error.message : error)
            .slice(0, 1024)
            .replace(uuid, ':id'),
          text: text.slice(0, 4096).replace(uuid, ':id'),
        }),
    )
    throw error
  } finally {
    fixture.signal.removeEventListener('abort', abort)
    await page.close()
  }
}

async function assertTabletGrid(page: Page, selector: string) {
  const grid = page.locator(selector).first()
  await expect(grid).toBeVisible()
  for (const width of [767, 768]) {
    await page.setViewportSize({ width, height: 1024 })
    await expect
      .poll(() =>
        grid.evaluate((node) => {
          const trackList = getComputedStyle(node).gridTemplateColumns
          return trackList === 'none' ? 1 : trackList.split(' ').length
        }),
      )
      .toBe(width === 768 ? 2 : 1)
  }
}
