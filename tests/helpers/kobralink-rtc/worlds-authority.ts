import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  browserLogin,
  browserLogout,
  pagePost,
  pageStatus,
  type Actor,
  type WorldContext,
} from './acceptance.ts'
import {
  actAt,
  channelSince,
  click,
  describeCounts,
  httpSince,
  marks,
  nothing,
  openReady,
  pause,
  prepareFresh,
  shownOperation,
} from './flow.ts'
import {
  SYNTHETIC_IP,
  TEXT,
  currentStage,
  fillTarget,
  kobraSection,
  mainText,
  openPrinters,
  shot,
} from './ui.ts'

const PENDING_KEY = 'openfarm:kobra-x-pending-op'
const AUTHORITY = /^\/api\/configuration-authority\/(challenges|capabilities)$/
const BOOTSTRAP = /^\/api\/farms\/:id\/connectors\/:id\/configuration$/

/**
 * One denied write through the real form: the actor's page is ready, then
 * authority is withdrawn, then the actor submits. Nothing may reach the
 * Connector, and nothing may be created anywhere.
 */
async function deniedPrepare(ctx: WorldContext, actor: Actor, lease: boolean) {
  const { page, observer } = actor
  const from = marks(ctx, observer)
  const attempt = await actAt(
    ctx,
    page,
    lease ? 'fresh' : 'now',
    click(page, TEXT.prepare),
  ).catch(async () => ({
    stage: await currentStage(page),
    alert: '',
    remainingMs: -1,
  }))
  const channel = channelSince(observer, from)
  const http = httpSince(observer, from).filter(
    (line) => AUTHORITY.test(line.split(' ')[1] ?? '') && line.endsWith(' 200'),
  )
  const counts = await ctx.counts()
  return {
    ok:
      attempt.stage !== 'prepared' &&
      attempt.stage !== 'confirmed' &&
      !channel.out.some((frame) => frame !== 'proof') &&
      http.length === 0 &&
      nothing(counts),
    detail: `stage=${attempt.stage} alert=${attempt.alert.slice(0, 90)} channel-out=${channel.out.join(',') || 'none'} authority-200=${http.length} ${describeCounts(counts)}`,
  }
}

/**
 * Authority world: a viewer, a member whose membership is revoked, a revoked
 * browser key and a revoked Connector each try to write. No assignment, bridge
 * device, operation or collection may appear.
 */
export async function authorityWorld(ctx: WorldContext) {
  const { checks, db } = ctx
  const q = 'revoked_authority_refused'
  // Every refusal below is the expected outcome of the scenario.
  ctx.allowHttp('GET', BOOTSTRAP, [401, 403, 404])
  ctx.allowHttp('POST', AUTHORITY, [400, 401, 403])
  ctx.allowHttp(
    'POST',
    /^\/api\/farms\/:id\/configuration-receipts$/,
    [400, 401, 403],
  )
  ctx.allowHttp('GET', /^\/api\/browser-devices$/, [401, 403])
  ctx.allowHttp(
    'GET',
    /^\/api\/farms\/:id\/(printers|connectors)$/,
    [401, 403, 404],
  )
  ctx.allowHttp(
    'GET',
    /^\/api\/signalling\/(metadata|pause-metadata)$/,
    [401, 403, 404],
  )

  // Viewer: the page offers no onboarding and the endpoints refuse.
  const viewer = await ctx.actor(
    'viewer',
    ctx.usernames.viewer,
    ctx.owner.page,
    { enroll: false },
  )
  await viewer.page.setViewportSize({ width: 1280, height: 900 })
  await openPrinters(viewer.page, ctx.origin, ctx.farmId)
  await expect(viewer.page.getByText(TEXT.viewerNotice)).toBeVisible()
  const viewerSection = await kobraSection(viewer.page).count()
  const viewerBootstrap = await pageStatus(
    viewer.page,
    'GET',
    `/api/farms/${ctx.farmId}/connectors/${ctx.agentId}/configuration?keyId=${ctx.owner.keyId}`,
  )
  const viewerReceipt = await pageStatus(
    viewer.page,
    'POST',
    `/api/farms/${ctx.farmId}/configuration-receipts`,
    { keyId: ctx.owner.keyId, receiptWire: 'synthetic-not-a-receipt' },
  )
  const viewerChallenge = await pageStatus(
    viewer.page,
    'POST',
    '/api/configuration-authority/challenges',
    {
      browserProofWire: 'synthetic',
      connectorProofWire: 'synthetic',
      admissionNonce: 'A'.repeat(43),
      action: 'prepare',
      operationId: randomUUID(),
      expectedRevision: 0,
      targetSha256: 'A'.repeat(43),
    },
  )
  await shot(viewer.page, ctx.root, 'viewer-desktop1280.png')
  const afterViewer = await ctx.counts()
  await checks.record(
    q,
    'viewer-refused',
    viewerSection === 0 &&
      viewerBootstrap === 403 &&
      viewerReceipt >= 400 &&
      viewerReceipt < 500 &&
      viewerChallenge >= 400 &&
      viewerChallenge < 500 &&
      nothing(afterViewer),
    `form=${viewerSection} bootstrap=${viewerBootstrap} receipt=${viewerReceipt} challenge=${viewerChallenge} ${describeCounts(afterViewer)}`,
  )

  // Revoked membership: an administrator loses the farm after loading the form.
  const member = await ctx.actor('member', ctx.usernames.member, ctx.owner.page)
  await openReady(ctx, member)
  await fillTarget(member.page, SYNTHETIC_IP, 'Associação revogada')
  const membershipRevoked = await db.revokeMembership(
    ctx.farmId,
    member.accountId,
  )
  const memberAttempt = await deniedPrepare(ctx, member, true)
  await shot(member.page, ctx.root, 'revoked-membership-desktop1280.png')
  await checks.record(
    q,
    'revoked-membership-refused',
    membershipRevoked && memberAttempt.ok,
    memberAttempt.detail,
  )

  // Revoked browser key: the owner's own device key is revoked by an admin.
  await openReady(ctx, ctx.owner)
  await fillTarget(ctx.owner.page, SYNTHETIC_IP, 'Chave revogada')
  await pagePost(ctx.admin.page, '/api/browser-devices/revoke', {
    farm_id: ctx.farmId,
    key_id: ctx.owner.keyId,
    expected_thumbprint: ctx.owner.thumbprint,
  })
  const keyStatus = await db.browserKeyStatus(ctx.owner.keyId)
  const keyAttempt = await deniedPrepare(ctx, ctx.owner, true)
  await shot(ctx.owner.page, ctx.root, 'revoked-key-desktop1280.png')
  await checks.record(
    q,
    'revoked-browser-key-refused',
    keyStatus === 'revoked' && keyAttempt.ok,
    `key=${keyStatus} ${keyAttempt.detail}`,
  )

  // Revoked Connector: the product's revocation tombstones the enrollment
  // together with its issued credential.
  await openReady(ctx, ctx.admin)
  await fillTarget(ctx.admin.page, SYNTHETIC_IP, 'Connector revogado')
  await ctx.revokeConnector()
  const revoked = await db.connector(ctx.agentId)
  await pause(1000)
  const connectorAttempt = await deniedPrepare(ctx, ctx.admin, false)
  await shot(ctx.admin.page, ctx.root, 'revoked-connector-desktop1280.png')
  await checks.record(
    q,
    'revoked-connector-refused',
    revoked.enrollment === 'revoked' &&
      revoked.revocations === 1 &&
      revoked.credentialTombstones === 1 &&
      connectorAttempt.ok,
    `enrollment=${revoked.enrollment} tombstones=${revoked.credentialTombstones} ${connectorAttempt.detail}`,
  )

  const final = await ctx.counts()
  await checks.record(
    q,
    'denied-cases-add-nothing',
    nothing(final) && final.operations === 0,
    describeCounts(final),
  )
}

/**
 * Credential-expiry world. The schema only tombstones a credential together
 * with its revoked enrollment, so the credential-only case is the one the
 * product can actually reach: the issued credential stops being valid while
 * the enrollment is still approved and nothing was revoked.
 */
export async function credentialExpiryWorld(ctx: WorldContext) {
  const { checks, db } = ctx
  const actor = ctx.owner
  ctx.allowHttp('GET', BOOTSTRAP, [401, 403, 404])
  ctx.allowHttp('POST', AUTHORITY, [401, 403])
  await openReady(ctx, actor)
  await fillTarget(actor.page, SYNTHETIC_IP, 'Credencial expirada')
  const before = await db.connector(ctx.agentId)
  // Isolated credential revocation does not exist in this product: the
  // revocation table only accepts a tombstone for an already revoked
  // enrollment. Proven against the real database, then rolled back.
  const tombstone = await db.credentialOnlyTombstone(
    ctx.agentId,
    actor.accountId,
  )
  await checks.record(
    'revoked_authority_refused',
    'credential-only-revocation-unreachable-by-schema',
    !tombstone.inserted &&
      /Revocation requires the exact revoked enrollment/.test(
        tombstone.rejected,
      ) &&
      tombstone.unchanged &&
      tombstone.enrollment === 'approved' &&
      before.revocations === 0,
    `insert-accepted=${tombstone.inserted} trigger="${tombstone.rejected}" rows-unchanged=${tombstone.unchanged} enrollment=${tombstone.enrollment}`,
  )
  const wait = before.credentialExpiresAtMs + 2500 - Date.now()
  if (wait > 120_000) throw new Error('Credential lifetime is not short')
  if (wait > 0) await pause(wait)
  const after = await db.connector(ctx.agentId)
  const attempt = await deniedPrepare(ctx, actor, false)
  await shot(actor.page, ctx.root, 'expired-credential-desktop1280.png')
  await checks.record(
    'revoked_authority_refused',
    'expired-credential-refused-enrollment-approved',
    Date.now() > after.credentialExpiresAtMs &&
      after.enrollment === 'approved' &&
      after.revocations === 0 &&
      attempt.ok,
    `enrollment=${after.enrollment} revocations=${after.revocations} expired=${Date.now() > after.credentialExpiresAtMs} ${attempt.detail}`,
  )
  await actor.page.getByRole('button', { name: TEXT.verify }).click()
  await pause(2500)
  await ctx.checks.record(
    'revoked_authority_refused',
    'denied-cases-add-nothing',
    nothing(await ctx.counts()),
    `after expiry: ${(await mainText(actor.page)).match(/Configuração não disponível[^.]*\./)?.[0] ?? 'form state unchanged'}`,
  )
}

async function pendingRaw(page: Page) {
  return page.evaluate((key) => sessionStorage.getItem(key), PENDING_KEY)
}

/**
 * Account-switch world: one tab, two accounts. The owner leaves an operation
 * pending and signs out; an administrator signs in on the same tab. The
 * pending operation must not be shown to, restored for or usable by the
 * administrator, even when the stored entry is forged to name them, and it
 * must still belong to the owner afterwards.
 */
export async function accountSwitchWorld(ctx: WorldContext) {
  const { checks } = ctx
  const q = 'account_switch_isolated'
  ctx.allowHttp('POST', AUTHORITY, [403])
  // One tab that both accounts use, each with its own approved key.
  const tab = await ctx.actor('shared-tab', ctx.usernames.owner, ctx.admin.page)
  const { page, observer } = tab
  await browserLogout(page, ctx.origin)
  await browserLogin(page, ctx.origin, ctx.usernames.admin, ctx.password)
  const adminKey = await ctx.enroll(page, ctx.owner.page)
  await browserLogout(page, ctx.origin)
  await browserLogin(page, ctx.origin, ctx.usernames.owner, ctx.password)

  const prepared = await prepareFresh(ctx, tab, 'Kobra troca de conta')
  if (prepared.stage !== 'prepared')
    throw new Error(`Prepare ended in ${prepared.stage}`)
  const operation = await shownOperation(page)
  await page.reload()
  await openPrinters(page, ctx.origin, ctx.farmId)
  await expect(page.locator('#kobra-reconcile-heading'))
    .toBeVisible({ timeout: 15_000 })
    .catch(() => {})
  const ownerRaw = await pendingRaw(page)
  await shot(page, ctx.root, 'switch-owner-pending-desktop1280.png')
  await checks.record(
    q,
    'pending-restored-for-owner',
    operation.length === 36 &&
      (await currentStage(page)) === 'reconcile' &&
      (await shownOperation(page)) === operation &&
      ownerRaw !== null,
    `stage=${await currentStage(page)} stored=${ownerRaw !== null}`,
  )

  // Switch accounts on the same tab.
  await browserLogout(page, ctx.origin)
  await browserLogin(page, ctx.origin, ctx.usernames.admin, ctx.password)
  await openPrinters(page, ctx.origin, ctx.farmId)
  await expect(page.locator('#kobra-device-key')).toBeVisible()
  await pause(2500)
  const adminStage = await currentStage(page)
  const leaked = (await page.content()).includes(operation)
  const stillStored = (await pendingRaw(page)) !== null
  await shot(page, ctx.root, 'switch-admin-desktop1280.png')
  await checks.record(
    q,
    'pending-hidden-from-other-account',
    adminStage === 'form' && !leaked,
    `stage=${adminStage} operation-in-dom=${leaked} entry-left-in-tab-storage=${stillStored}`,
  )

  // Forged restore: the stored entry is rewritten to name the administrator.
  const forgedFrom: unknown = JSON.parse(ownerRaw ?? '{}')
  await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), {
    key: PENDING_KEY,
    value: JSON.stringify({
      ...(forgedFrom as Record<string, unknown>),
      accountId: adminKey.accountId,
      keyId: adminKey.keyId,
    }),
  })
  await page.reload()
  await openPrinters(page, ctx.origin, ctx.farmId)
  await expect(page.locator('#kobra-device-key')).toBeVisible()
  await expect(page.locator('#kobra-reconcile-heading'))
    .toBeVisible({ timeout: 10_000 })
    .catch(() => {})
  const forgedStage = await currentStage(page)
  const attempts: string[] = [`restored=${forgedStage}`]
  let forgedRefused = forgedStage !== 'prepared' && forgedStage !== 'confirmed'
  if (forgedStage === 'reconcile') {
    for (const name of [TEXT.reconcile, TEXT.cancelRemote]) {
      const from = marks(ctx, observer)
      const attempt = await actAt(ctx, page, 'fresh', click(page, name))
      const channel = channelSince(observer, from)
      const authority = httpSince(observer, from).filter((line) =>
        line.includes('configuration-authority'),
      )
      attempts.push(
        `${name === TEXT.reconcile ? 'status' : 'cancel'}:${attempt.stage}:${authority.join(',')}:out=${channel.out.join('+')}`,
      )
      forgedRefused &&=
        attempt.stage === 'reconcile' &&
        !channel.out.some((frame) => frame !== 'proof') &&
        authority.length > 0 &&
        authority.every((line) => line.endsWith(' 403'))
    }
  }
  const afterForgery = await ctx.counts()
  await shot(page, ctx.root, 'switch-forged-desktop1280.png')
  await checks.record(
    q,
    'forged-restore-refused',
    forgedRefused &&
      afterForgery.assignments === 0 &&
      afterForgery.bridgePrinters === 1 &&
      afterForgery.bridgeDeletes === 0,
    `${attempts.join(' | ')} ${describeCounts(afterForgery)}`,
  )

  // Back to the owner: the operation is still theirs to consult and cancel.
  if (ownerRaw !== null)
    await page.evaluate(
      ({ key, value }) => sessionStorage.setItem(key, value),
      { key: PENDING_KEY, value: ownerRaw },
    )
  await browserLogout(page, ctx.origin)
  await browserLogin(page, ctx.origin, ctx.usernames.owner, ctx.password)
  await openPrinters(page, ctx.origin, ctx.farmId)
  await expect(page.locator('#kobra-reconcile-heading')).toBeVisible({
    timeout: 15_000,
  })
  const consult = await actAt(ctx, page, 'fresh', click(page, TEXT.reconcile))
  const cancel =
    consult.stage === 'prepared'
      ? await actAt(ctx, page, 'fresh', click(page, TEXT.cancelPrepared))
      : consult
  const final = await ctx.counts()
  await shot(page, ctx.root, 'switch-owner-cancelled-desktop1280.png')
  await checks.record(
    q,
    'owner-keeps-own-operation',
    (await shownOperation(page)) !== adminKey.keyId &&
      consult.stage === 'prepared' &&
      cancel.stage === 'form' &&
      final.bridgePrinters === 0 &&
      final.bridgeDeletes === 1 &&
      final.assignments === 0,
    `consult=${consult.stage} cancel=${cancel.stage} ${describeCounts(final)}`,
  )
}
