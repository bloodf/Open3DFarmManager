import { expect, type Page } from '@playwright/test'
import type { Actor, Counts, WorldContext } from './acceptance.ts'
import type { PageObserver } from './observe.ts'
import {
  SYNTHETIC_IP,
  TEXT,
  alertText,
  fillTarget,
  kobraSection,
  openPrinters,
  selectKobraContext,
  settledStage,
  waitFormReady,
  type Stage,
} from './ui.ts'

export const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Real page, real selections, real capability check. */
export async function openReady(ctx: WorldContext, actor: Actor) {
  await actor.page.setViewportSize({ width: 1280, height: 900 })
  actor.page.setDefaultTimeout(30_000)
  await openPrinters(actor.page, ctx.origin, ctx.farmId)
  await selectKobraContext(actor.page, ctx.agentId, actor.keyId)
  await waitFormReady(actor.page)
}

export type Attempt = Readonly<{
  stage: Stage
  alert: string
  remainingMs: number
}>

/** Performs `action` at a chosen point of the real inbox lease, then settles. */
export async function actAt(
  ctx: WorldContext,
  page: Page,
  kind: 'fresh' | 'near-rotation' | 'now',
  action: () => Promise<void>,
  settleMs = 40_000,
): Promise<Attempt> {
  const remainingMs = kind === 'now' ? -1 : await ctx.host.waitLease(kind)
  await action()
  // The busy flag is raised asynchronously; give it a moment to appear so a
  // stage read before the operation started is never reported.
  await expect(kobraSection(page))
    .toHaveAttribute('aria-busy', 'true', { timeout: 1500 })
    .catch(() => {})
  const stage = await settledStage(page, settleMs)
  return { stage, alert: await alertText(page), remainingMs }
}

export const click = (page: Page, name: string) => () =>
  page.getByRole('button', { name, exact: true }).click()

export async function prepareFresh(
  ctx: WorldContext,
  actor: Actor,
  nickname: string,
) {
  await openReady(ctx, actor)
  await fillTarget(actor.page, SYNTHETIC_IP, nickname)
  return actAt(ctx, actor.page, 'fresh', click(actor.page, TEXT.prepare))
}

export function marks(ctx: WorldContext, observer: PageObserver) {
  return {
    ...observer.mark(),
    events: ctx.host.events.length,
    connectorFrames: ctx.host.frames.length,
    transport: ctx.host.transport.length,
  }
}
type Marks = ReturnType<typeof marks>

/** What the page put on, and read from, the data channel since `from`. */
export function channelSince(observer: PageObserver, from: Marks) {
  const entries = observer.diagnostics.slice(from.diagnostics)
  const out = entries
    .filter((entry) => entry.event === 'dc-out')
    .map((entry) =>
      entry.t === 'request' ? `${entry.frameType}` : `${entry.t}`,
    )
  const incoming = entries
    .filter((entry) => entry.event === 'dc-in')
    .map((entry) =>
      entry.t === 'response'
        ? `${entry.frameType}:${entry.frameState ?? entry.frameCode ?? entry.frameReason ?? ''}`
        : entry.t === 'inventory-result'
          ? `inventory-result:${entry.ok}`
          : `${entry.t}`,
    )
  return { out, incoming }
}

/** Signalling frame kinds on both sides, and bridge calls, since `from`. */
export function signallingSince(
  ctx: WorldContext,
  observer: PageObserver,
  from: Marks,
) {
  return {
    browser: observer.frames
      .slice(from.frames)
      .filter((frame) => frame.path === '/api/signalling/config-browser')
      .map((frame) => `${frame.dir}:${frame.t}@${frame.atMs}`),
    connector: ctx.host.frames
      .slice(from.connectorFrames)
      .filter((frame) => frame.t !== 'rtc.ice')
      .map((frame) => `${frame.dir}:${frame.t}@${frame.atMs}`),
    bridge: ctx.host.transport
      .slice(from.transport)
      .filter((entry) => entry.target === 'bridge')
      .map((entry) => `${entry.method} ${entry.path} ${entry.status}`),
  }
}

export function httpSince(observer: PageObserver, from: Marks) {
  return observer.http
    .slice(from.http)
    .map((entry) => `${entry.method} ${entry.path} ${entry.status}`)
}

export function eventsSince(ctx: WorldContext, from: Marks) {
  return ctx.host.events
    .slice(from.events)
    .map((event) =>
      event.kind === 'configuration-activation'
        ? `${String(event.reason)}:${String(event.result)}`
        : event.kind === 'runtime-activation'
          ? `runtime:${String(event.result)}`
          : String(event.kind),
    )
}

export const describeCounts = (counts: Counts) =>
  `assignments=${counts.assignments} receipts=${counts.receipts} operations=${counts.operations} bridge=${counts.bridgePrinters} creates=${counts.bridgeCreates} deletes=${counts.bridgeDeletes} runtime=${counts.runtimePrinters} activated=${counts.activated}`

/** Exactly one registered, confirmed, collecting printer and one creation. */
export const single = (counts: Counts) =>
  counts.assignments === 1 &&
  counts.receipts === 1 &&
  counts.bridgePrinters === 1 &&
  counts.bridgeCreates === 1 &&
  counts.runtimePrinters === 1

/** No row, device or collection exists anywhere. */
export const nothing = (counts: Counts) =>
  counts.assignments === 0 &&
  counts.receipts === 0 &&
  counts.bridgePrinters === 0 &&
  counts.bridgeCreates === 0 &&
  counts.runtimePrinters === 0 &&
  counts.activated === 0

export const sameCounts = (a: Counts, b: Counts) =>
  a.assignments === b.assignments &&
  a.receipts === b.receipts &&
  a.bridgePrinters === b.bridgePrinters &&
  a.bridgeCreates === b.bridgeCreates &&
  a.runtimePrinters === b.runtimePrinters

/** The operation identifier the visible card shows. */
export async function shownOperation(page: Page): Promise<string> {
  const text = await page
    .locator(
      '#kobra-reconcile-heading ~ p .exact-key, #kobra-recovery-heading ~ p .exact-key, #kobra-prepared-heading ~ dl dd.exact-key',
    )
    .first()
    .innerText()
    .catch(() => '')
  return text.trim()
}
