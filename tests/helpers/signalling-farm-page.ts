import assert from 'node:assert/strict'
import { expect } from '@playwright/test'
import type { ProvisionedSignallingFixture } from './signalling-https-fixture-contract.ts'

/** Uses the generated page, its stored key and production feed; no API interception. */
export async function testAuthenticatedFarmPage(input: {
  fixture: ProvisionedSignallingFixture
  closure: 'disconnect' | 'revocation'
  startedAt: number
  advance(): Promise<void>
  note(value: string): Promise<void>
}) {
  const { fixture } = input
  const assignment = fixture.assignmentRefs[0]
  assert.equal(fixture.assignmentRefs.length, 1)
  assert.ok(assignment)
  fixture.signal.throwIfAborted()
  const page = await fixture.ownerContext.newPage()
  const responses: { path: string; status: number }[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (
      url.origin === fixture.origin &&
      url.pathname.startsWith('/api/') &&
      responses.length < 32
    )
      responses.push({
        path: url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'),
        status: response.status(),
      })
  })
  page.setDefaultTimeout(7500)
  const abort = () => {
    void page.close().catch(() => {})
  }
  fixture.signal.addEventListener('abort', abort, { once: true })
  try {
    fixture.signal.throwIfAborted()
    const response = await page.goto(fixture.origin + '/farm', {
      waitUntil: 'domcontentloaded',
      timeout: 7500,
    })
    assert.equal(response?.status(), 200)
    await expect(
      page.getByRole('heading', { name: 'Minha farm', exact: true }),
    ).toBeVisible()
    await page
      .getByLabel('Farm atual', { exact: true })
      .selectOption(fixture.farmId)
    await page
      .getByLabel('Dispositivo aprovado deste navegador', { exact: true })
      .selectOption(fixture.browserKeyId)
    const row = page.getByRole('article').filter({
      has: page.getByRole('heading', {
        name: assignment.printerKey,
        exact: true,
      }),
    })
    await expect(
      row.getByText('Conexão direta autenticada', { exact: true }),
    ).toBeVisible()
    await expect(row.getByRole('progressbar')).toHaveAttribute('value', '0.25')
    await expect(
      row.getByRole('button', { name: 'Pausar impressão', exact: true }),
    ).toBeDisabled()
    await expect(
      row.getByText('Horário da observação não confirmado', { exact: true }),
    ).toBeVisible()
    await input.advance()
    await expect(row.getByRole('progressbar')).toHaveAttribute(
      'value',
      '0.75',
      { timeout: 3000 },
    )
    const closureWait = input.closure === 'revocation' ? 7500 : 3000
    assert.ok(performance.now() - input.startedAt + closureWait + 2500 < 28000)
    await (input.closure === 'disconnect'
      ? fixture.disconnectSignalling()
      : fixture.revokeConnector())
    await expect(
      row.getByText(
        'Conexão direta indisponível. Exibindo a última observação.',
        { exact: true },
      ),
    ).toBeVisible({ timeout: closureWait })
    await expect(
      row.getByRole('button', { name: 'Pausar impressão', exact: true }),
    ).toBeDisabled()
    await page.waitForTimeout(250)
    await expect(row.getByRole('progressbar')).toHaveAttribute('value', '0.75')
    await expect(
      row.getByText('Conexão direta autenticada', { exact: true }),
    ).toHaveCount(0)
    assert.ok(performance.now() - input.startedAt < 28000)
    fixture.signal.throwIfAborted()
  } catch (error) {
    const text = await page
      .locator('main')
      .innerText({ timeout: 1000 })
      .catch(() => 'Page unavailable')
    await input.note(
      'farm-page-failure:' +
        JSON.stringify({
          responses,
          text: text
            .slice(0, 4096)
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'),
        }),
    )
    throw error
  } finally {
    fixture.signal.removeEventListener('abort', abort)
    await page.close()
  }
}
