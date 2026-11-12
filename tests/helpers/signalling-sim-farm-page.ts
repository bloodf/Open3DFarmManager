import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import type { ProvisionedSignallingFixture } from './signalling-https-fixture-contract.ts'

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
    await expect(row.getByText('Ociosa', { exact: true })).toBeVisible()
    const temperatures = row.locator(
      'dl[aria-label="Temperaturas observadas"] dd',
    )
    await expect(temperatures).toHaveCount(2)
    const readings = await temperatures.allInnerTexts()
    for (const reading of readings) assert.match(reading, /^-?[\d.,]+ °C$/)
    await expect(
      row.getByRole('button', { name: 'Pausar impressão', exact: true }),
    ).toBeDisabled()
    await input.note(
      'farm-page-simulator-observed:' +
        JSON.stringify({ state: 'Ociosa', temperatures: readings }),
    )
    // Spoolman inventory relayed by the Connector over the same channel.
    const caption = page.getByText(/^Bobinas \(\d+ de \d+\)$/)
    await expect(caption).toBeVisible({ timeout: 15000 })
    const [shown, total] = (await caption.innerText())
      .match(/\d+/g)!
      .map(Number)
    assert.ok(shown! >= seed.spools.length && total! >= shown!)
    const table = page.getByRole('region', { name: /^Bobinas: / })
    for (const filament of seed.filaments)
      await expect(
        table.getByRole('rowheader', { name: filament.name, exact: true }),
      ).not.toHaveCount(0)
    await input.note(`farm-page-simulator-spools:${shown}/${total}`)
    // Issue #8: read-only within 10 s of losing the direct connection.
    const closedAt = performance.now()
    await fixture.disconnectSignalling()
    await expect(
      row.getByText(
        'Conexão direta indisponível. Exibindo a última observação.',
        { exact: true },
      ),
    ).toBeVisible({ timeout: 10000 })
    await input.note(
      `farm-page-readonly-after-ms:${Math.round(performance.now() - closedAt)}`,
    )
    await expect(
      row.getByRole('button', { name: 'Pausar impressão', exact: true }),
    ).toBeDisabled()
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
