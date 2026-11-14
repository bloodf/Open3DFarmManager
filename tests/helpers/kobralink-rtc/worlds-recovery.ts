import { expect, type Locator, type Page } from '@playwright/test'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorldContext } from './acceptance.ts'
import { pageStatus } from './acceptance.ts'
import {
  actAt,
  channelSince,
  click,
  describeCounts,
  eventsSince,
  httpSince,
  marks,
  pause,
  prepareFresh,
  shownOperation,
  signallingSince,
  single,
} from './flow.ts'
import {
  SYNTHETIC_DEVICE_ID,
  SYNTHETIC_IP,
  TEXT,
  alertText,
  currentStage,
  kobraAlert,
  liveArticle,
  openPrinters,
  overflow,
  settledStage,
  shot,
  tabTo,
  unlabelled,
} from './ui.ts'

const MOBILE = { width: 375, height: 812 }

/** Chooses an option of a focused `<select>` using the keyboard only. */
async function keyboardChoose(page: Page, select: Locator, value: string) {
  if ((await select.inputValue()) === value) return 'preselected'
  // Type-ahead on the closed control (option labels start with the value).
  await page.keyboard.type(value.slice(0, 8), { delay: 20 })
  if ((await select.inputValue()) === value) return 'type-ahead'
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press('ArrowDown')
    if ((await select.inputValue()) === value) return 'arrow'
  }
  await page.keyboard.press('Escape')
  await page.keyboard.press('Space')
  await page.keyboard.type(value.slice(0, 8), { delay: 20 })
  await page.keyboard.press('Enter')
  return (await select.inputValue()) === value ? 'popup' : 'failed'
}

/**
 * Think-time world. An administrator registers the printer on a 375 px wide
 * page using only the keyboard, at the pace of a person: submissions land
 * near the rotation of the Connector's real inbox lease and after at least
 * one real renewal. Timing is observed, never extended: the 10 000 ms proof
 * TTL and the production MIN_CONTEXT_MS stay as shipped.
 */
export async function thinkTimeWorld(ctx: WorldContext) {
  const actor = ctx.admin
  const { page, observer } = actor
  const { checks, host } = ctx
  const think = 'think_time_lease_renewal'
  const mobile = 'mobile_keyboard_accessibility'
  const invisible: string[] = []
  const unreachable: string[] = []
  const screenshots: string[] = []
  const reach = async (target: Locator, name: string) => {
    const result = await tabTo(page, target)
    invisible.push(...result.invisible)
    if (!result.reached) unreachable.push(name)
    return result.reached
  }
  // Refusals of an operation the server never admitted are expected here.
  ctx.allowHttp('POST', /^\/api\/configuration-authority\/challenges$/, [403])

  await page.setViewportSize(MOBILE)
  page.setDefaultTimeout(30_000)
  await page.goto(ctx.origin + '/impressoras')
  const farm = page.locator('#printer-farm')
  await expect(farm.locator('option')).toHaveCount(2)
  await reach(farm, 'farm')
  const farmMethod = await keyboardChoose(page, farm, ctx.farmId)
  await expect(page.locator('#kobra-x-heading')).toBeVisible()
  const connector = page.locator('#kobra-connector')
  await reach(connector, 'connector')
  const connectorMethod = await keyboardChoose(page, connector, ctx.agentId)
  const key = page.locator('#kobra-device-key')
  await expect(key).toBeVisible()
  await reach(key, 'device-key')
  const keyMethod = await keyboardChoose(page, key, actor.keyId)
  const verify = page.getByRole('button', { name: TEXT.verify })
  const ip = page.locator('#kobra-ip')
  for (let attempt = 0; attempt < 12 && !(await ip.isEnabled()); attempt++) {
    await reach(verify, 'verify')
    await page.keyboard.press('Enter')
    await expect(ip)
      .toBeEnabled({ timeout: 3000 })
      .catch(() => {})
  }
  await expect(ip).toBeEnabled()

  // Error state at phone width, keyboard only.
  await reach(ip, 'ip')
  await page.keyboard.type('http://kobra.local')
  await page.keyboard.press('Enter')
  await expect(kobraAlert(page)).toBeFocused({ timeout: 5000 })
  const mobileError = await alertText(page)
  screenshots.push(await shot(page, ctx.root, 'error-mobile375.png'))
  const errorOverflow = await overflow(page)
  await checks.record(
    mobile,
    'mobile-error-state',
    /somente o endereço IPv4/.test(mobileError),
    mobileError.slice(0, 120),
  )

  const typeTarget = async () => {
    await reach(ip, 'ip')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(SYNTHETIC_IP)
    await reach(page.locator('#kobra-label'), 'nickname')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Kobra teclado')
  }
  const submit = () => page.keyboard.press('Enter')

  // 1. Prepare submitted near rotation: less than MIN_CONTEXT_MS remains.
  await typeTarget()
  let from = marks(ctx, observer)
  const early = await actAt(ctx, page, 'near-rotation', submit)
  const afterEarly = await ctx.counts()
  const earlyChannel = channelSince(observer, from)
  const earlyRefused = early.stage !== 'prepared'
  const earlySignalling = signallingSince(ctx, observer, from)
  const earlyHttp = httpSince(observer, from).filter((line) =>
    line.includes('configuration-authority'),
  )
  if (earlyRefused)
    // Bind the refusal to what actually crossed each boundary: the browser
    // asked for a context and was closed before `config.ready`; the Connector
    // was never asked for one; no authority, prepare frame or bridge call.
    await checks.record(
      think,
      'prepare-refusal-never-reached-connector',
      earlySignalling.browser.some((f) => f.startsWith('out:config.begin')) &&
        !earlySignalling.browser.some((f) => f.startsWith('in:config.ready')) &&
        !earlySignalling.connector.some((f) =>
          f.startsWith('in:config.context-request'),
        ) &&
        earlyHttp.length === 0 &&
        earlyChannel.out.length === 0 &&
        earlySignalling.bridge.length === 0,
      `browser-ws=${earlySignalling.browser.join(',') || 'none'} connector-ws=${earlySignalling.connector.join(',') || 'none'} authority-http=${earlyHttp.length} data-channel-out=${earlyChannel.out.length} bridge-calls=${earlySignalling.bridge.length}`,
    )
  else
    await checks.record(
      think,
      'prepare-refusal-never-reached-connector',
      true,
      'not refused: admitted on this attempt',
    )
  await checks.record(
    think,
    'prepare-near-rotation-safe',
    early.stage === 'prepared'
      ? afterEarly.bridgeCreates === 1 && afterEarly.assignments === 0
      : earlyChannel.out.length === 0 &&
          afterEarly.bridgeCreates === 0 &&
          afterEarly.bridgePrinters === 0 &&
          afterEarly.assignments === 0 &&
          afterEarly.operations === 0,
    `remaining=${early.remainingMs}ms stage=${early.stage} alert=${early.alert.slice(0, 80)} ${describeCounts(afterEarly)}`,
  )
  if (earlyRefused) {
    screenshots.push(
      await shot(page, ctx.root, 'prepare-refused-mobile375.png'),
    )
    // What a person would do next, with a fresh lease each time.
    const steps: string[] = [`refused:${early.stage}`]
    let recovered = false
    if (early.stage === 'reconcile') {
      await reach(
        page.getByRole('button', { name: TEXT.reconcile, exact: true }),
        'reconcile',
      )
      from = marks(ctx, observer)
      const consult = await actAt(ctx, page, 'fresh', submit)
      steps.push(
        `reconcile:${consult.stage}:${consult.alert.slice(0, 60)}:${httpSince(
          observer,
          from,
        )
          .filter((line) => line.includes('configuration-authority'))
          .join(',')}`,
      )
      recovered = consult.stage === 'form' || consult.stage === 'prepared'
      if (!recovered && consult.stage === 'reconcile') {
        await reach(
          page.getByRole('button', { name: TEXT.cancelRemote, exact: true }),
          'cancel',
        )
        const cancel = await actAt(ctx, page, 'fresh', submit)
        steps.push(`cancel:${cancel.stage}:${cancel.alert.slice(0, 60)}`)
        recovered = cancel.stage === 'form'
        if (!recovered) {
          await page.reload()
          await page.locator('#printer-farm').selectOption(ctx.farmId)
          await expect(page.locator('#kobra-x-heading')).toBeVisible()
          await pause(2500)
          const reloaded = await currentStage(page)
          steps.push(`reload:${reloaded}`)
          recovered = reloaded === 'form'
        }
      }
    } else recovered = early.stage === 'form'
    if (!recovered)
      screenshots.push(
        await shot(page, ctx.root, 'prepare-refusal-dead-end-mobile375.png'),
      )
    await checks.record(
      think,
      'prepare-near-rotation-recoverable',
      recovered,
      steps.join(' -> '),
    )
    if (!recovered) {
      // Leave the dead end the only way the page allows: change the selected
      // Connector, which discards the never-admitted operation locally.
      await page.locator('#kobra-connector').selectOption('')
      await page.locator('#kobra-connector').selectOption(ctx.agentId)
      await expect(page.locator('#kobra-ip')).toBeVisible()
    }
    for (let attempt = 0; attempt < 12 && !(await ip.isEnabled()); attempt++) {
      await reach(verify, 'verify')
      await page.keyboard.press('Enter')
      await expect(ip)
        .toBeEnabled({ timeout: 3000 })
        .catch(() => {})
    }
    await typeTarget()
    const again = await actAt(ctx, page, 'fresh', submit)
    if (again.stage !== 'prepared') {
      // Fixed Connector categories only: stage, frame type and error class.
      const failed = ctx.host.events
        .filter((event) => event.state === 'frame-failed')
        .map((event) => `${event.stage}/${event.frame}/${event.error}`)
      throw new Error(
        `Prepare on a fresh lease ended in ${again.stage} (connector frame failures: ${failed.join(', ') || 'none'})`,
      )
    }
  } else {
    await checks.record(
      think,
      'prepare-near-rotation-recoverable',
      true,
      'admitted without refusal',
    )
  }
  await expect(
    page.getByText(SYNTHETIC_DEVICE_ID, { exact: true }),
  ).toBeVisible()
  screenshots.push(await shot(page, ctx.root, 'prepared-mobile375.png'))
  const preparedOverflow = await overflow(page)
  const preparedUnlabelled = await unlabelled(page)
  await checks.record(
    mobile,
    'mobile-form-keyboard-only',
    unreachable.length === 0 &&
      [farmMethod, connectorMethod, keyMethod].every((m) => m !== 'failed'),
    `farm=${farmMethod} connector=${connectorMethod} key=${keyMethod} unreachable=${unreachable.join(',')}`,
  )

  // 2. Think-time: at least one real inbox renewal while the person reads.
  const renewalsAtPrepared = host.renewals()
  await host.waitRenewals(renewalsAtPrepared + 1)
  await checks.record(
    think,
    'renewal-observed-during-think-time',
    host.renewals() > renewalsAtPrepared,
    `renewals ${renewalsAtPrepared} -> ${host.renewals()}`,
  )

  // 3. Commit submitted near rotation.
  const confirmBox = page.locator('#kobra-confirm-checkbox')
  const commitButton = page.getByRole('button', {
    name: TEXT.commit,
    exact: true,
  })
  await reach(confirmBox, 'confirm-checkbox')
  await page.keyboard.press('Space')
  await expect(confirmBox).toBeChecked()
  await reach(commitButton, 'commit')
  from = marks(ctx, observer)
  const late = await actAt(ctx, page, 'near-rotation', submit)
  const afterLate = await ctx.counts()
  const lateEvents = eventsSince(ctx, from)
  await checks.record(
    think,
    'commit-near-rotation-safe',
    late.stage === 'confirmed'
      ? single(afterLate)
      : afterLate.assignments === 0 &&
          afterLate.bridgeCreates === 1 &&
          !lateEvents.some((event) => event.startsWith('inventory-confirmed')),
    `remaining=${late.remainingMs}ms stage=${late.stage} alert=${late.alert.slice(0, 80)} ${describeCounts(afterLate)}`,
  )
  let stage = late.stage
  if (stage !== 'confirmed') {
    screenshots.push(await shot(page, ctx.root, 'reconcile-mobile375.png'))
    const steps: string[] = [`refused:${stage}`]
    if (stage === 'reconcile') {
      await reach(
        page.getByRole('button', { name: TEXT.reconcile, exact: true }),
        'reconcile',
      )
      const consult = await actAt(ctx, page, 'fresh', submit)
      stage = consult.stage
      steps.push(`reconcile:${stage}:${consult.alert.slice(0, 60)}`)
    }
    await checks.record(
      think,
      'commit-near-rotation-recoverable',
      stage === 'prepared' || stage === 'confirmed',
      steps.join(' -> '),
    )
    if (stage !== 'prepared' && stage !== 'confirmed')
      throw new Error(`Commit refusal left the page in ${stage}`)
  } else
    await checks.record(
      think,
      'commit-near-rotation-recoverable',
      true,
      'admitted without refusal',
    )

  // 4. Fresh admission after the renewal completes the same operation.
  if (stage === 'prepared') {
    await reach(confirmBox, 'confirm-checkbox')
    await page.keyboard.press('Space')
    await expect(confirmBox).toBeChecked()
    await reach(commitButton, 'commit')
    const done = await actAt(ctx, page, 'fresh', submit, 60_000)
    stage = done.stage
  }
  screenshots.push(await shot(page, ctx.root, 'confirmed-mobile375.png'))
  const confirmedOverflow = await overflow(page)
  const final = await ctx.counts()
  await checks.record(
    think,
    'fresh-admission-after-renewal',
    stage === 'confirmed',
    `stage=${stage}`,
  )
  await checks.record(
    mobile,
    'mobile-identity-confirm-commit',
    stage === 'confirmed',
    `stage=${stage}`,
  )
  await checks.record(
    'revoked_authority_refused',
    'admin-write-succeeds',
    stage === 'confirmed' && single(final),
    describeCounts(final),
  )
  await checks.record(
    think,
    'no-duplicate-after-think-time',
    single(final),
    describeCounts(final),
  )

  // 5. Live view at phone width, reached with the keyboard.
  await reach(page.getByRole('link', { name: 'Minha farm' }), 'farm-link')
  await page.keyboard.press('Enter')
  await page.waitForURL((url) => url.pathname === '/farm')
  const live = await expect(
    page.getByText(TEXT.liveAuthenticated, { exact: true }),
  )
    .toBeVisible({ timeout: 60_000 })
    .then(
      () => true,
      () => false,
    )
  const idle = await expect(page.getByRole('article').first())
    .toContainText(TEXT.idle, { timeout: 30_000 })
    .then(
      () => true,
      () => false,
    )
  screenshots.push(await shot(page, ctx.root, 'live-mobile375.png'))
  const liveOverflow = await overflow(page)
  const liveUnlabelled = await unlabelled(page)
  const card = await liveArticle(page)
  await checks.record(
    mobile,
    'mobile-live-view',
    live && idle && card.count === 1,
    card.text.slice(0, 120),
  )
  const overflows = [
    ['error', errorOverflow],
    ['prepared', preparedOverflow],
    ['confirmed', confirmedOverflow],
    ['live', liveOverflow],
  ] as const
  await checks.record(
    mobile,
    'no-horizontal-overflow',
    overflows.every(
      ([, o]) => o.offenders.length === 0 && o.scrollWidth <= o.viewport + 1,
    ),
    overflows
      .map(
        ([name, o]) =>
          `${name}:${o.scrollWidth}/${o.viewport}:${o.offenders.join('+')}`,
      )
      .join(' '),
  )
  await checks.record(
    mobile,
    'controls-labelled',
    preparedUnlabelled.length === 0 && liveUnlabelled.length === 0,
    `mobile375 unlabelled=${[...preparedUnlabelled, ...liveUnlabelled].join(',')}`,
  )
  await checks.record(
    mobile,
    'focus-visible',
    invisible.length === 0,
    `stops without a visible focus ring: ${[...new Set(invisible)].join(',')}`,
  )
  let captured = 0
  for (const name of screenshots)
    await access(join(ctx.root, name)).then(
      () => captured++,
      () => {},
    )
  await checks.record(
    mobile,
    'screenshots-captured',
    captured === screenshots.length && captured >= 5,
    screenshots.join(','),
  )
}

/**
 * Lost-reply world: the Connector commits locally but its reply never reaches
 * the page. The page must not assume success, a reload must bring the same
 * operation back, and reconciling must finish it without a second creation.
 */
export async function lostReplyWorld(ctx: WorldContext) {
  const actor = ctx.owner
  const { page, observer } = actor
  const { checks } = ctx
  const q = 'lost_ack_recovery'
  const prepared = await prepareFresh(ctx, actor, 'Kobra resposta perdida')
  if (prepared.stage !== 'prepared')
    throw new Error(`Prepare ended in ${prepared.stage}`)
  await page.locator('#kobra-confirm-checkbox').check()
  await page.evaluate(() => {
    if (window.__kobraFault) window.__kobraFault.dropResponseFor = 'commit'
  })
  let from = marks(ctx, observer)
  const lost = await actAt(ctx, page, 'fresh', click(page, TEXT.commit))
  const operation = await shownOperation(page)
  const afterLoss = await ctx.counts()
  const lossEvents = eventsSince(ctx, from)
  await shot(page, ctx.root, 'lost-reply-desktop1280.png')
  await checks.record(
    q,
    'reply-lost-unconfirmed',
    lost.stage === 'reconcile' &&
      /Resultado não confirmado/.test(lost.alert) &&
      lossEvents.includes('local-commit:unconfirmed') &&
      !lossEvents.some((event) => event.startsWith('inventory-confirmed')) &&
      afterLoss.assignments === 0 &&
      afterLoss.activated === 0 &&
      (await page.getByRole('button', { name: TEXT.prepare }).count()) === 0,
    `stage=${lost.stage} events=${lossEvents.join(',')} ${describeCounts(afterLoss)}`,
  )
  await page.reload()
  await openPrinters(page, ctx.origin, ctx.farmId)
  await expect(page.locator('#kobra-x-heading')).toBeVisible()
  await expect(page.locator('#kobra-reconcile-heading'))
    .toBeVisible({ timeout: 15_000 })
    .catch(() => {})
  const restored = await shownOperation(page)
  await checks.record(
    q,
    'reload-restores-pending-operation',
    (await currentStage(page)) === 'reconcile' &&
      operation.length === 36 &&
      restored === operation,
    `stage=${await currentStage(page)} same-operation=${restored === operation}`,
  )
  from = marks(ctx, observer)
  const done = await actAt(
    ctx,
    page,
    'fresh',
    click(page, TEXT.reconcile),
    60_000,
  )
  const channel = channelSince(observer, from)
  const final = await ctx.counts()
  await shot(page, ctx.root, 'lost-reply-confirmed-desktop1280.png')
  await checks.record(
    q,
    'reconcile-confirms-same-operation',
    done.stage === 'confirmed' &&
      channel.out.join(',') === 'proof,status,inventory' &&
      channel.incoming.includes('result:local-committed') &&
      channel.incoming.includes('inventory-result:true'),
    `stage=${done.stage} alert=${done.alert.slice(0, 80)} out=${channel.out.join(',')} in=${channel.incoming.join(',')}`,
  )
  await checks.record(
    q,
    'no-duplicate-after-lost-reply',
    single(final),
    describeCounts(final),
  )
}

/**
 * Late-acknowledgement world: the server registers the receipt, but the
 * signed inventory acknowledgement never reaches the Connector. Collection
 * must not start. The old transport's proofs and the old acknowledgement must
 * be worthless afterwards; only a newly admitted status on a new transport,
 * followed by a fresh acknowledgement, may confirm the same operation.
 */
export async function lateAckWorld(ctx: WorldContext) {
  const actor = ctx.owner
  const { page, observer } = actor
  const { checks, host } = ctx
  const q = 'late_ack_fresh_authority'
  // Replaying the expired transport's requests is refused by design.
  ctx.allowHttp(
    'POST',
    /^\/api\/configuration-authority\/(challenges|capabilities)$/,
    [403],
  )
  const prepared = await prepareFresh(ctx, actor, 'Kobra ack tardio')
  if (prepared.stage !== 'prepared')
    throw new Error(`Prepare ended in ${prepared.stage}`)
  await page.locator('#kobra-confirm-checkbox').check()
  await page.evaluate(() => {
    if (window.__kobraFault) window.__kobraFault.dropInventory = true
  })
  let from = marks(ctx, observer)
  const renewals = host.renewals()
  const lost = await actAt(ctx, page, 'fresh', click(page, TEXT.commit))
  const afterLoss = await ctx.counts()
  const lossEvents = eventsSince(ctx, from)
  await shot(page, ctx.root, 'late-ack-pending-desktop1280.png')
  await checks.record(
    q,
    'server-registered-connector-unconfirmed',
    lost.stage === 'reconcile' &&
      afterLoss.assignments === 1 &&
      afterLoss.receipts === 1 &&
      afterLoss.activated === 0 &&
      lossEvents.includes('local-commit:unconfirmed') &&
      !lossEvents.some((event) => event.startsWith('inventory-confirmed')),
    `stage=${lost.stage} events=${lossEvents.join(',')} ${describeCounts(afterLoss)}`,
  )

  // The transport that carried the commit expires with its inbox lease.
  await host.waitRenewals(renewals + 1)
  const old = await page.evaluate(() => ({
    challenge: window.__kobraFault?.oldChallengeBody ?? null,
    capability: window.__kobraFault?.oldCapabilityBody ?? null,
    channel: !window.__kobraFault?.channels.length
      ? 'absent'
      : window.__kobraFault.channels.every((c) => c.readyState === 'closed')
        ? 'closed'
        : 'open',
    kept: window.__kobraFault?.inventoryWire !== null,
  }))
  const challengeStatus = old.challenge
    ? await pageStatus(
        page,
        'POST',
        '/api/configuration-authority/challenges',
        old.challenge,
      )
    : -1
  const capabilityStatus = old.capability
    ? await pageStatus(
        page,
        'POST',
        '/api/configuration-authority/capabilities',
        old.capability,
      )
    : -1
  await checks.record(
    q,
    'expired-transport-proof-refused',
    challengeStatus === 403 &&
      capabilityStatus === 403 &&
      old.channel === 'closed' &&
      old.kept,
    `challenge=${challengeStatus} capability=${capabilityStatus} old-channel=${old.channel}`,
  )

  await page.evaluate(() => {
    const fault = window.__kobraFault
    if (!fault) return
    fault.replayBeforeStatus = true
    fault.replayBeforeInventory = true
  })
  from = marks(ctx, observer)
  const done = await actAt(
    ctx,
    page,
    'fresh',
    click(page, TEXT.reconcile),
    60_000,
  )
  const injected = await page.evaluate(
    () => window.__kobraFault?.injected ?? [],
  )
  const channel = channelSince(observer, from)
  const doneEvents = eventsSince(ctx, from)
  const final = await ctx.counts()
  await shot(page, ctx.root, 'late-ack-confirmed-desktop1280.png')
  await checks.record(
    q,
    'old-ack-without-admitted-status-refused',
    injected.length >= 1 && injected[0]?.ok === false,
    `replayed before status: ok=${String(injected[0]?.ok)} reason=${String(injected[0]?.reason)}`,
  )
  await checks.record(
    q,
    'old-ack-on-new-transport-refused',
    injected.length === 2 && injected[1]?.ok === false,
    `replayed after admitted status: ok=${String(injected[1]?.ok)} reason=${String(injected[1]?.reason)}`,
  )
  await checks.record(
    q,
    'fresh-status-then-ack-confirms',
    done.stage === 'confirmed' &&
      channel.out.join(',') === 'proof,status,inventory' &&
      channel.incoming.includes('result:local-committed') &&
      channel.incoming.includes('inventory-result:true') &&
      doneEvents.includes('inventory-confirmed:activated'),
    `stage=${done.stage} alert=${done.alert.slice(0, 80)} out=${channel.out.join(',')} in=${channel.incoming.join(',')} events=${doneEvents.join(',')}`,
  )
  await checks.record(
    q,
    'no-duplicate-after-late-ack',
    single(final) && final.activated === 1,
    describeCounts(final),
  )
  await settledStage(page)
}
