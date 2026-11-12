import assert from 'node:assert/strict'
import { expect } from '@playwright/test'
import type { ProvisionedSignallingFixture } from './signalling-https-fixture-contract.ts'
import {
  assertCameraDetached,
  assertCameraPlaying,
} from './signalling-farm-camera.ts'
import type { CameraFixture } from './signalling-camera-fixture.ts'

/** Mirrors REOPEN_MAX_MS in apps/farm/app/utils/farm-view.ts (#121). */
const REOPEN_BACKOFF_CAP_MS = 30_000

/** Uses the generated page, its stored key and production feed; no API interception. */
export async function testAuthenticatedFarmPage(input: {
  fixture: ProvisionedSignallingFixture
  closure: 'disconnect' | 'revocation'
  startedAt: number
  advance(): Promise<void>
  note(value: string): Promise<void>
  /** Camera row: video must play before the closure and detach after it. */
  camera?: CameraFixture
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
    const open = () =>
      page.goto(fixture.origin + '/farm', {
        waitUntil: 'domcontentloaded',
        timeout: 7500,
      })
    // Chromium aborts a navigation when host interfaces change (for example a
    // container network appearing on a shared Docker host). Retry that once.
    const response = await open().catch((error: unknown) => {
      if (!String(error).includes('net::ERR_NETWORK_CHANGED')) throw error
      return open()
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
    const camera = input.camera
      ? await assertCameraPlaying({
          page,
          printerKey: assignment.printerKey,
          helperPath: input.camera.helperPath,
          note: input.note,
        })
      : undefined
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
    await expect(
      row.getByRole('button', { name: 'Pausar impressão', exact: true }),
    ).toBeDisabled()
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
      await expect(
        row.getByRole('button', { name: 'Pausar impressão', exact: true }),
      ).toBeDisabled()
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
      if (camera && input.camera)
        await assertCameraDetached({
          page,
          ...camera,
          helperPath: input.camera.helperPath,
          note: input.note,
        })
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
