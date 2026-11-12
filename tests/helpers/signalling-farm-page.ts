import assert from 'node:assert/strict'
import { expect } from '@playwright/test'
import type { ProvisionedSignallingFixture } from './signalling-https-fixture-contract.ts'

/** Mirrors REOPEN_MAX_MS in apps/farm/app/utils/farm-view.ts (#121). */
const REOPEN_BACKOFF_CAP_MS = 30_000

/** Uses the generated page, its stored key and production feed; no API interception. */
export async function testAuthenticatedFarmPage(input: {
  fixture: ProvisionedSignallingFixture
  closure: 'disconnect' | 'revocation'
  startedAt: number
  advance(): Promise<void>
  note(value: string): Promise<void>
  /** Farm pause row only: pause requests the synthetic Moonraker received. */
  pauses?: () => Promise<number>
}) {
  const farmPause = !!input.pauses
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
    // The maintained view selects its sole farm and approved key automatically.
    await expect(page.getByLabel('Farm atual', { exact: true })).toHaveValue(
      fixture.farmId,
    )
    await expect(
      page.getByLabel('Dispositivo aprovado deste navegador', { exact: true }),
    ).toHaveValue(fixture.browserKeyId)
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
    const pauseButton = row.getByRole('button', {
      name: 'Pausar impressão',
      exact: true,
    })
    if (farmPause) await expect(pauseButton).toBeEnabled()
    else await expect(pauseButton).toBeDisabled()
    await expect(
      row.getByText('Horário da observação não confirmado', { exact: true }),
    ).toBeVisible()
    await input.advance()
    await expect(row.getByRole('progressbar')).toHaveAttribute(
      'value',
      '0.75',
      { timeout: 3000 },
    )
    // Issue #8: read-only within 10 s of losing the direct connection.
    const closureWait = 10000
    const sockets: number[] = []
    page.on('websocket', () => sockets.push(performance.now()))
    const closedAt = performance.now()
    await (input.closure === 'disconnect'
      ? fixture.disconnectSignalling()
      : fixture.revokeConnector())
    await expect(
      row.getByText(
        'Conexão direta indisponível. Exibindo a última observação.',
        { exact: true },
      ),
    ).toBeVisible({ timeout: closureWait })
    await input.note(
      `farm-page-readonly-after-ms:${Math.round(performance.now() - closedAt)}`,
    )
    await expect(pauseButton).toBeDisabled()
    if (farmPause) {
      // Stale: the reason names the lost live connection, and nothing is sent.
      await expect(pauseButton).toHaveAccessibleDescription(
        'Pausa indisponível. Não há conexão direta ao vivo.',
      )
      assert.equal(await input.pauses!(), 0)
      await input.note('farm-page-pause-stale-disabled-with-reason')
    }
    await page.waitForTimeout(250)
    await expect(row.getByRole('progressbar')).toHaveAttribute('value', '0.75')
    await expect(
      row.getByText('Conexão direta autenticada', { exact: true }),
    ).toHaveCount(0)
    if (input.closure === 'disconnect') {
      // #121: the view re-checks authority and reopens with bounded backoff while
      // the Connector reconnects its signalling session; live status returns.
      await expect(
        row.getByText('Conexão direta autenticada', { exact: true }),
      ).toBeVisible({ timeout: REOPEN_BACKOFF_CAP_MS })
      await input.note(
        `farm-page-recovered-after-ms:${Math.round(performance.now() - closedAt)}`,
      )
      // Recovery must carry new data, not only the retained observation.
      await input.advance()
      await expect(row.getByRole('progressbar')).toHaveAttribute(
        'value',
        '0.9',
        { timeout: 3000 },
      )
      if (farmPause)
        await testFarmPagePause({
          fixture,
          page,
          row,
          pauseButton,
          note: input.note,
          pauses: input.pauses!,
        })
      else await expect(pauseButton).toBeDisabled()
    } else {
      // Revocation stops: no signalling socket reopens for longer than the
      // view's maximum reopen backoff, and live status never returns.
      await page.waitForTimeout(REOPEN_BACKOFF_CAP_MS + 1000)
      assert.deepEqual(sockets, [], 'No signalling reopen after revocation')
      await expect(
        row.getByText('Conexão direta autenticada', { exact: true }),
      ).toHaveCount(0)
      await input.note(
        `farm-page-no-reopen-window-ms:${REOPEN_BACKOFF_CAP_MS + 1000}`,
      )
    }
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

/**
 * Signed pause through the real page: dialog, admission with a fresh signed
 * capability, one confirmed command over WebRTC to the Connector, exactly one
 * pause on the synthetic Moonraker. Then revocation leaves it disabled.
 */
async function testFarmPagePause(input: {
  fixture: ProvisionedSignallingFixture
  page: import('@playwright/test').Page
  row: import('@playwright/test').Locator
  pauseButton: import('@playwright/test').Locator
  note(value: string): Promise<void>
  pauses(): Promise<number>
}) {
  const { page, row, pauseButton } = input
  await expect(pauseButton).toBeEnabled()
  assert.equal(await input.pauses(), 0)
  const commandRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET')
      commandRequests.push(url.pathname)
  })
  await pauseButton.click()
  const dialog = page.getByRole('dialog', { name: /^Pausar impressão de/ })
  await expect(dialog).toBeVisible()
  const confirm = dialog.getByRole('button', {
    name: 'Confirmar pausa',
    exact: true,
  })
  // Nothing is sent before the explicit confirmation.
  await expect(dialog.getByRole('status')).toHaveText(/^Autorização pronta\./, {
    timeout: 15000,
  })
  assert.equal(await input.pauses(), 0)
  await expect(confirm).toBeEnabled()
  const confirmedAt = performance.now()
  await confirm.click()
  await expect(dialog.getByRole('status')).toHaveText(
    'Impressão pausada. O Connector confirmou a pausa.',
    { timeout: 10000 },
  )
  await input.note(
    `farm-page-pause-applied-after-ms:${Math.round(performance.now() - confirmedAt)}`,
  )
  assert.equal(await input.pauses(), 1, 'Exactly one synthetic pause')
  // Only the issuer routes are posted; the command itself never uses HTTP.
  assert.deepEqual([...new Set(commandRequests)].sort(), [
    '/api/pause-authority/capabilities',
    '/api/pause-authority/challenges',
  ])
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(pauseButton).toBeFocused()
  await expect(row.getByText('Pausada', { exact: true })).toBeVisible({
    timeout: 5000,
  })
  await expect(pauseButton).toBeDisabled()
  await expect(pauseButton).toHaveAccessibleDescription(
    'Pausa indisponível. A impressora não está imprimindo.',
  )
  // Revocation: control stays disabled with a reason, nothing else is sent.
  const revokedAt = performance.now()
  await input.fixture.revokeConnector()
  await expect(
    row.getByText(
      'Conexão direta indisponível. Exibindo a última observação.',
      {
        exact: true,
      },
    ),
  ).toBeVisible({ timeout: 10000 })
  await expect(pauseButton).toBeDisabled()
  await expect(pauseButton).toHaveAccessibleDescription(
    /^Pausa indisponível\. /,
  )
  await input.note(
    `farm-page-pause-revoked-disabled-after-ms:${Math.round(performance.now() - revokedAt)}`,
  )
  assert.equal(await input.pauses(), 1, 'No pause after revocation')
  await input.note('farm-page-pause-exactly-one-applied')
}
