import assert from 'node:assert/strict'
import { expect, type Page } from '@playwright/test'
import { join } from 'node:path'
import type { WorldContext } from '../helpers/kobralink-rtc/acceptance.ts'
import { signalPrinter } from '../helpers/kobralink-rtc/audit.ts'
import {
  actAt,
  click,
  describeCounts,
  marks,
  channelSince,
  openReady,
  pause,
  sameCounts,
  single,
} from '../helpers/kobralink-rtc/flow.ts'
import {
  SYNTHETIC_DEVICE_ID,
  SYNTHETIC_IP,
  TEXT,
  alertText,
  currentStage,
  fillTarget,
  kobraAlert,
  liveArticle,
  openPrinters,
  overflow,
  shot,
  unlabelled,
} from '../helpers/kobralink-rtc/ui.ts'

/**
 * The accepted positive chain. Called only by the admitted sealed-Nitro
 * runner; no HTTP interception. `beforePrepare` lets the caller submit while
 * the Connector inbox lease is fresh instead of relying on a lucky click.
 */
export async function driveFirstRegistration(input: {
  page: Page
  origin: string
  farmId: string
  agentId: string
  browserKeyId: string
  evidence: string
  events: readonly Readonly<Record<string, unknown>>[]
  beforePrepare?: () => Promise<unknown>
  beforeCommit?: () => Promise<unknown>
}) {
  const { page } = input
  await page.setViewportSize({ width: 1280, height: 900 })
  page.setDefaultTimeout(30_000)
  await page.goto(input.origin + '/impressoras')
  await page.getByLabel('Farm', { exact: true }).selectOption(input.farmId)
  await page
    .getByLabel('Connector aprovado para a Kobra X')
    .selectOption(input.agentId)
  await page
    .getByLabel('Dispositivo aprovado deste navegador', { exact: true })
    .selectOption(input.browserKeyId)
  await expect
    .poll(
      async () => {
        await page
          .getByRole('button', { name: 'Verificar capacidade do Connector' })
          .click()
        return expect(page.getByLabel('Endereço IPv4 da Kobra X na LAN'))
          .toBeEnabled({ timeout: 3000 })
          .then(
            () => true,
            () => false,
          )
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true)
  await page.getByLabel('Endereço IPv4 da Kobra X na LAN').fill(SYNTHETIC_IP)
  await page
    .getByLabel('Apelido local para identificação (opcional)')
    .fill('Kobra sintética RTC')
  await expect(page.locator('#kobra-device-id')).toHaveValue('')
  await input.beforePrepare?.()
  await page
    .getByRole('button', { name: 'Preparar Anycubic Kobra X', exact: true })
    .click()
  await expect(page.locator('#kobra-confirm-checkbox')).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.getByText(SYNTHETIC_DEVICE_ID, { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: join(input.evidence, 'prepared-desktop1280.png'),
    fullPage: true,
  })
  assert.equal(
    input.events.some(
      (e) => e.kind === 'runtime-activation' && e.result === 'activated',
    ),
    false,
    'Collector must remain stopped before inventory confirmation',
  )
  await page.locator('#kobra-confirm-checkbox').check()
  await input.beforeCommit?.()
  await page
    .getByRole('button', { name: 'Confirmar e ativar Kobra X', exact: true })
    .click()
  await expect(
    page.getByRole('heading', {
      name: 'Anycubic Kobra X confirmada e ativa em modo somente leitura',
    }),
  ).toBeVisible({ timeout: 60_000 })
  const localCommitIdx = input.events.findIndex(
    (e) =>
      e.kind === 'configuration-activation' &&
      e.reason === 'local-commit' &&
      e.result === 'unconfirmed',
  )
  const confirmedIdx = input.events.findIndex(
    (e) =>
      e.kind === 'configuration-activation' &&
      e.reason === 'inventory-confirmed' &&
      e.result === 'activated',
  )
  assert.ok(
    localCommitIdx >= 0 && confirmedIdx > localCommitIdx,
    'Local commit must remain unconfirmed until signed inventory acknowledgement activates collection',
  )
  await page.screenshot({
    path: join(input.evidence, 'confirmed-desktop1280.png'),
    fullPage: true,
  })
  assert.equal(
    page
      .context()
      .pages()
      .filter((p) => new URL(p.url()).origin !== input.origin).length,
    0,
  )
  assert.equal(await page.locator('iframe').count(), 0)
  await page.goto(input.origin + '/farm')
  await expect(
    page.getByText('Conexão direta autenticada', { exact: true }),
  ).toBeVisible({ timeout: 60_000 })
  const articles = page.getByRole('article')
  await expect(articles).toHaveCount(1)
  await expect(
    articles.first().getByText('Ociosa', { exact: true }),
  ).toBeVisible()
  assert.equal(await page.locator('iframe, video').count(), 0)
  await page.screenshot({
    path: join(input.evidence, 'live-desktop1280.png'),
    fullPage: true,
  })
}

/** The connection and state lines of a live card, without identifiers. */
function cardState(text: string) {
  const from = text.indexOf('Conexão direta')
  const to = text.indexOf('Capacidades admitidas')
  return text.slice(Math.max(0, from), to > from ? to : from + 260).trim()
}
async function liveAgain(page: Page, timeoutMs = 60_000) {
  return expect(page.getByText(TEXT.liveAuthenticated, { exact: true }))
    .toBeVisible({ timeout: timeoutMs })
    .then(
      () => true,
      () => false,
    )
}
async function articleShows(page: Page, text: string, timeoutMs: number) {
  return expect(page.getByRole('article').first())
    .toContainText(text, { timeout: timeoutMs })
    .then(
      () => true,
      () => false,
    )
}

/**
 * Positive world: the accepted first registration again, then reload,
 * signalling reconnect, Connector restart, a repeated registration attempt and
 * the truthful offline, stale and unknown live states.
 */
export async function positiveWorld(ctx: WorldContext) {
  const { page, observer } = ctx.owner
  const { checks, host } = ctx
  const first = 'first_registration_without_device_id'
  const mobile = 'mobile_keyboard_accessibility'
  const stale = 'stale_error_capabilities'
  const reload = 'reload_reconnect_no_duplicate'

  // Validation errors on the real form at desktop width, before any session.
  await openReady(ctx, ctx.owner)
  const errors: string[] = []
  for (const value of ['http://ponte.local:7100', '8.8.8.8']) {
    await fillTarget(page, value, '')
    await page.getByRole('button', { name: TEXT.prepare, exact: true }).click()
    await expect(kobraAlert(page)).toBeFocused({ timeout: 5000 })
    errors.push(await alertText(page))
  }
  await shot(page, ctx.root, 'error-desktop1280.png')
  const desktopOverflow = await overflow(page)
  await checks.record(
    mobile,
    'desktop-error-state',
    errors.length === 2 &&
      /somente o endereço IPv4/.test(errors[0] ?? '') &&
      /IPv4 privado válido/.test(errors[1] ?? '') &&
      (await currentStage(page)) === 'form',
    errors.join(' | '),
  )
  await checks.record(
    mobile,
    'no-horizontal-overflow',
    desktopOverflow.offenders.length === 0 &&
      desktopOverflow.scrollWidth <= desktopOverflow.viewport + 1,
    `desktop1280 scrollWidth=${desktopOverflow.scrollWidth} offenders=${desktopOverflow.offenders.join(',')}`,
  )
  const desktopUnlabelled = await unlabelled(page)
  await checks.record(
    mobile,
    'controls-labelled',
    desktopUnlabelled.length === 0,
    `desktop1280 unlabelled=${desktopUnlabelled.join(',')}`,
  )

  await driveFirstRegistration({
    page,
    origin: ctx.origin,
    farmId: ctx.farmId,
    agentId: ctx.agentId,
    browserKeyId: ctx.owner.keyId,
    evidence: ctx.root,
    events: host.events,
    beforePrepare: () => host.waitLease('fresh'),
    beforeCommit: () => host.waitLease('fresh'),
  })
  // Every assertion inside the accepted drive passed to reach this line.
  await checks.record(first, 'device-id-left-empty', true)
  await checks.record(first, 'identity-observed-before-commit', true)
  await checks.record(first, 'confirmed-heading', true)
  await checks.record('single_ui', 'no-foreign-pages', true)
  await checks.record('single_ui', 'no-iframe', true)
  await checks.record(
    'inventory_before_live',
    'collector-stopped-before-inventory',
    true,
  )
  await checks.record(
    'inventory_before_live',
    'local-commit-unconfirmed-then-activated',
    true,
  )
  await checks.record('inventory_before_live', 'live-authenticated-idle', true)
  const registered = await ctx.counts()
  await checks.record(
    'revoked_authority_refused',
    'owner-write-succeeds',
    single(registered),
    describeCounts(registered),
  )

  // Unsupported Kobra controls and camera on the live card.
  const article = page.getByRole('article').first()
  const card = (await article.innerText()).replace(/\s+/g, ' ')
  await checks.record(
    stale,
    'kobra-controls-absent',
    (await article.getByRole('button').count()) === 0 &&
      (await article.getByRole('link').count()) === 0 &&
      (await article
        .locator('input, select, textarea, [role="button"]')
        .count()) === 0,
    `buttons=${await article.getByRole('button').count()} links=${await article.getByRole('link').count()}`,
  )
  await checks.record(
    stale,
    'kobra-camera-absent',
    (await page.locator('iframe, video, canvas, img').count()) === 0,
    `media elements=${await page.locator('iframe, video, canvas, img').count()}`,
  )
  await checks.record(
    stale,
    'capabilities-declared-unavailable',
    [
      'Admitido (somente leitura)',
      'Indisponível / não qualificado',
      'Não suportado',
      'Indisponível / não suportado',
      'Oculto por segurança',
    ].every((text) => card.includes(text)),
    'live card capability statuses',
  )

  // Reload keeps one assignment, one device and a live view.
  await page.reload()
  const liveAfterReload = await liveAgain(page)
  const afterReload = await ctx.counts()
  await openPrinters(page, ctx.origin, ctx.farmId)
  const rows = page.locator(
    'section[aria-labelledby="assignment-heading"] ul > li',
  )
  await expect(rows)
    .toHaveCount(1, { timeout: 15_000 })
    .catch(() => {})
  const listed = await rows.count()
  await checks.record(
    reload,
    'reload-preserves-counts',
    liveAfterReload &&
      sameCounts(registered, afterReload) &&
      listed === 1 &&
      (await currentStage(page)) === 'form',
    `${describeCounts(afterReload)} listed=${listed} live=${liveAfterReload}`,
  )

  // A second registration of the same printer is refused without a new row.
  await openReady(ctx, ctx.owner)
  await fillTarget(page, SYNTHETIC_IP, 'Tentativa repetida')
  const from = marks(ctx, observer)
  const repeat = await actAt(ctx, page, 'fresh', click(page, TEXT.prepare))
  const afterRepeat = await ctx.counts()
  await checks.record(
    reload,
    'repeat-registration-refused-without-duplicate',
    repeat.stage === 'form' &&
      /conflito de identidade/.test(repeat.alert) &&
      sameCounts(registered, afterRepeat),
    `stage=${repeat.stage} alert=${repeat.alert.slice(0, 90)} channel=${channelSince(observer, from).incoming.join(',')} ${describeCounts(afterRepeat)}`,
  )

  // Signalling drop: every upgraded socket is cut by the proxy, then recovers.
  await page.goto(ctx.origin + '/farm')
  await liveAgain(page)
  const renewalsBefore = host.renewals()
  await ctx.disconnectSignalling()
  await host.waitRenewals(renewalsBefore + 1, 45_000)
  let liveAfterDrop = await liveAgain(page, 30_000)
  let recovery = 'automatic'
  if (!liveAfterDrop) {
    recovery = 'after reload'
    await page.reload()
    liveAfterDrop = await liveAgain(page)
  }
  const afterDrop = await ctx.counts()
  await checks.record(
    reload,
    'reconnect-preserves-counts',
    liveAfterDrop && sameCounts(registered, afterDrop),
    `live=${liveAfterDrop} (${recovery}) ${describeCounts(afterDrop)}`,
  )

  // Connector restart on the same durable state.
  const restartFrom = host.events.length
  await host.restart()
  const restarted = await host.waitEvent(
    (event) => event.kind === 'configuration-ready',
    restartFrom,
  )
  const pendingAfterRestart = host.events
    .slice(restartFrom)
    .find((event) => event.kind === 'configuration-ready')?.pendingInventory
  await page.reload()
  const liveAfterRestart = await liveAgain(page)
  const afterRestart = await ctx.counts()
  await checks.record(
    reload,
    'connector-restart-preserves-counts',
    restarted &&
      pendingAfterRestart === 0 &&
      liveAfterRestart &&
      sameCounts(registered, afterRestart),
    `pendingInventory=${String(pendingAfterRestart)} live=${liveAfterRestart} ${describeCounts(afterRestart)}`,
  )

  // Offline printer: the synthetic device stops its MQTT service.
  // The view must be live first, so the label can only come from a report.
  const liveBeforeOffline =
    (await liveAgain(page, 20_000)) ||
    (await page.reload().then(() => liveAgain(page)))
  await signalPrinter(ctx.harness.printerContainer, 'SIGUSR1')
  // A read-only session outlives neither its authority nor a long wait, and a
  // card without a live session only shows the last observation. So each
  // look at the printer state uses a freshly admitted direct session.
  let offline = false
  let freshLooks = 0
  let lastFresh = ''
  /** Drops the direct session and admits a new one on a fresh lease. */
  const freshLook = async () => {
    const device = page.getByLabel('Dispositivo aprovado deste navegador', {
      exact: true,
    })
    const keyId = await device.inputValue()
    await device.selectOption('')
    await pause(10_000)
    await host.waitLease('fresh')
    await device.selectOption(keyId)
    return liveAgain(page, 30_000)
  }
  const offlineDeadline = Date.now() + 100_000
  while (
    liveBeforeOffline &&
    !offline &&
    freshLooks < 3 &&
    Date.now() < offlineDeadline
  ) {
    freshLooks++
    if (!(await freshLook())) continue
    offline = await articleShows(page, TEXT.offline, 8000)
    lastFresh = cardState((await liveArticle(page)).text)
  }
  const offlineCard = await liveArticle(page)
  await shot(page, ctx.root, 'offline-desktop1280.png')
  await checks.record(
    stale,
    'offline-reported-truthfully',
    offline && !offlineCard.text.includes(TEXT.idle),
    `live-before=${liveBeforeOffline} fresh-admissions=${freshLooks} last-fresh="${lastFresh.slice(0, 160)}" final="${cardState(offlineCard.text).slice(0, 160)}"`,
  )
  await signalPrinter(ctx.harness.printerContainer, 'SIGUSR2')

  // The printer is back: the stale check below needs a real last observation,
  // so the Connector is only stopped once a live session reports it again.
  let restored = false
  for (let look = 0; look < 3 && !restored; look++)
    restored =
      ((await liveAgain(page, 5000)) || (await freshLook())) &&
      (await articleShows(page, TEXT.idle, 15_000))

  // Connector stopped: last observation stays visible, flagged stale.
  await host.stop()
  const unavailable = await articleShows(page, TEXT.liveUnavailableLast, 30_000)
  const flagged = await articleShows(page, TEXT.staleNotice, 60_000)
  const staleCard = await liveArticle(page)
  await shot(page, ctx.root, 'stale-desktop1280.png')
  await checks.record(
    stale,
    'stale-after-connector-stop',
    restored &&
      unavailable &&
      flagged &&
      (await page.getByRole('article').first().getByRole('button').count()) ===
        0,
    `live-restored-before-stop=${restored} ${cardState(staleCard.text)}`,
  )

  // Unknown: a fresh page without any observation never invents a state.
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(1, { timeout: 30_000 })
  await pause(4000)
  const unknownCard = await liveArticle(page)
  await shot(page, ctx.root, 'unknown-desktop1280.png')
  await checks.record(
    stale,
    'unknown-before-first-state',
    unknownCard.text.includes(TEXT.noState) &&
      !unknownCard.text.includes(TEXT.idle) &&
      !unknownCard.text.includes(TEXT.liveAuthenticated),
    cardState(unknownCard.text),
  )
}
