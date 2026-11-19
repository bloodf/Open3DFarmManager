// Shared base of the farm-manager journeys (#388 and the Phase 3b journeys).
// Boots the built farm app, database and Connector through the E16 journey
// harness (tests/journey/harness.ts), signs in the owner, and seeds mock
// printers of chosen families on loopback port 0. Every browser context the
// harness or the helpers create blocks any request outside 127.0.0.1 and
// localhost, and the test fails when one was attempted.
import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import {
  browserLogin,
  pagePost,
} from '../../helpers/kobralink-rtc/acceptance.ts'
import {
  startJourneyHarness,
  type JourneyHarness,
  type SimulatorName,
  type VendorName,
  type VendorSimulator,
} from '../../journey/harness.ts'
import { startVendorSimulator } from '../../journey/harness-vendors.ts'
import {
  startMoonrakerSimulator,
  type MoonrakerSimulator,
} from '../../journey/moonraker-simulator.ts'
import {
  startKobraXMock,
  type KobraXMockInstance,
} from '../../../packages/sim-tools/src/mocks/index.ts'

export type PrinterFamily =
  'moonraker' | 'bambu' | 'creality' | 'anycubic' | 'kobra-x'

export type FarmRole = 'owner' | 'admin' | 'operator' | 'viewer'

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
])

export type NetworkGuard = Readonly<{
  /** Every http(s) request that targeted a non-loopback host, in order. */
  blocked(): readonly string[]
  install(context: BrowserContext): Promise<void>
}>

/** Blocks and records every request whose host is not 127.0.0.1/localhost. */
export function createNetworkGuard(): NetworkGuard {
  const blocked: string[] = []
  return {
    blocked: () => [...blocked],
    async install(context) {
      await context.route(
        (url) => !LOOPBACK_HOSTS.has(url.hostname),
        async (route) => {
          blocked.push(route.request().method() + ' ' + route.request().url())
          await route.abort('blockedbyclient')
        },
      )
    },
  }
}

/** The browser, with every context it creates guarded before first use. */
function guardedBrowser(browser: Browser, guard: NetworkGuard): Browser {
  return new Proxy(browser, {
    get(target, property) {
      if (property === 'newContext')
        return async (...args: Parameters<Browser['newContext']>) => {
          const context = await target.newContext(...args)
          await guard.install(context)
          return context
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export type PrinterSeed = Readonly<{
  family: PrinterFamily
  /** Farm printer key; defaults to `<family>-<position>` (1-based). */
  printerKey?: string
}>

export type SeededPrinter = Readonly<{
  family: PrinterFamily
  printerKey: string
  /**
   * True when the Connector collects this printer, so the farm page shows live
   * telemetry. Only a single-printer boot is live: the E16 harness configures
   * the Connector for one assignment, and a farm with more registered
   * printers shows each of them without a direct connection.
   */
  live: boolean
  /** The loopback mock of this printer, for scripted state and assertions. */
  mock: MoonrakerSimulator | VendorSimulator | KobraXMockInstance | undefined
}>

export type BootOptions = Readonly<{
  /** Printers to seed, first one first. At least one; a lone printer is live. */
  printers: readonly PrinterSeed[]
  /** Forwarded to the harness: stores job history on the server. */
  history?: boolean
  /** Forwarded to the harness: signed control for the live printer. */
  signedControl?: boolean
}>

export type FarmManager = Readonly<{
  harness: JourneyHarness
  origin: string
  farmId: string
  printers: readonly SeededPrinter[]
  /** The signed-in owner page (device key enrolled, on the origin). */
  owner: Page
  /** A fresh page, in a fresh guarded context, signed in as `role`. */
  signInAs(role: FarmRole): Promise<Page>
  /** Opens /farm in `page` (default: the owner) and waits for the heading. */
  openFarm(page?: Page): Promise<void>
  /** The printer's article on the open farm page. */
  printerCard(printerKey: string, page?: Page): ReturnType<Page['locator']>
  /** Outbound requests blocked so far (empty on a clean run). */
  blockedRequests(): readonly string[]
  /** Throws when any outbound request was attempted. */
  assertNoOutbound(): void
}>

const HARNESS_SIMULATOR: Readonly<
  Record<Exclude<PrinterFamily, 'kobra-x'>, SimulatorName>
> = {
  moonraker: 'moonraker-fixture',
  bambu: 'bambu',
  creality: 'creality',
  anycubic: 'anycubic',
}

async function startSeedMock(
  family: PrinterFamily,
  printerKey: string,
): Promise<SeededPrinter['mock']> {
  if (family === 'moonraker') return startMoonrakerSimulator()
  if (family === 'kobra-x') return startKobraXMock({ reportIntervalMs: 0 })
  return startVendorSimulator(family as VendorName, { printerKey })
}

async function closeMock(mock: SeededPrinter['mock']) {
  if (mock && 'close' in mock) await mock.close()
}

async function bootFarm(
  browser: Browser,
  guard: NetworkGuard,
  options: BootOptions,
  onClose: (close: () => Promise<void>) => void,
): Promise<FarmManager> {
  const [first, ...rest] = options.printers
  if (!first) throw new Error('boot needs at least one printer')
  if (first.family === 'kobra-x')
    throw new Error(
      'The first printer is the live one and must be moonraker, bambu, creality or anycubic; Kobra X mocks are seeded after it',
    )
  process.env.OPENFARM_JOURNEY = '1'
  const keyOf = (seed: PrinterSeed, index: number) =>
    seed.printerKey ?? `${seed.family}-${index + 1}`
  const keys = options.printers.map(keyOf)
  if (new Set(keys).size !== keys.length)
    throw new Error('Printer keys must be unique')

  const harness = await startJourneyHarness({
    browser: guardedBrowser(browser, guard),
    simulator: HARNESS_SIMULATOR[first.family],
    printerKey: keys[0]!,
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.signedControl === undefined
      ? {}
      : { signedControl: options.signedControl }),
  })
  const seeded: SeededPrinter[] = [
    {
      family: first.family,
      printerKey: keys[0]!,
      live: rest.length === 0,
      mock: harness.vendor ?? harness.printer,
    },
  ]
  onClose(() => harness.close())
  try {
    // The harness configures the Connector for one printer. The others are
    // registered on the same paired Connector through the farm's own
    // assignment API and get their own loopback mock; the Connector does not
    // collect them, and registering them drops the direct connection.
    for (const [offset, seed] of rest.entries()) {
      const printerKey = keys[offset + 1]!
      const mock = await startSeedMock(seed.family, printerKey)
      onClose(() => closeMock(mock))
      await pagePost(
        harness.ownerPage,
        `/api/farms/${harness.farmId}/printers`,
        {
          agentId: harness.agentId,
          printerKey,
          confirmedLocalConfiguration: true,
        },
      )
      seeded.push({ family: seed.family, printerKey, live: false, mock })
    }
  } catch (error) {
    console.error(harness.appLog())
    throw error
  }

  const printerCard = (printerKey: string, page: Page = harness.ownerPage) =>
    page.getByRole('article').filter({
      has: page.getByRole('heading', { name: printerKey, exact: true }),
    })

  const operatorAccount = async () => {
    // The harness has owner, admin and viewer accounts. The operator is the
    // viewer account promoted through the members API, as an owner would.
    const members = (await harness.ownerPage.evaluate(
      async (farmId) =>
        (
          await fetch(`/api/farms/${farmId}/members`, { cache: 'no-store' })
        ).json(),
      harness.farmId,
    )) as { members: { accountId: string; username: string | null }[] }
    const viewer = members.members.find(
      (member) => member.username === harness.accounts.viewer,
    )
    if (!viewer) throw new Error('Viewer account not listed')
    await pagePost(
      harness.ownerPage,
      `/api/farms/${harness.farmId}/members/${viewer.accountId}/role`,
      { role: 'operator' },
    )
    return harness.accounts.viewer
  }

  const signInAs = async (role: FarmRole): Promise<Page> => {
    if (role === 'owner') return harness.newOwnerPage()
    if (role === 'admin' || role === 'viewer') return harness.signInAs(role)
    // Operator: promote the viewer account, then sign in with it.
    const username = await operatorAccount()
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    await guard.install(context)
    onClose(() => context.close())
    const page = await context.newPage()
    await browserLogin(
      page,
      harness.origin,
      username,
      harness.accounts.password,
    )
    return page
  }

  return Object.freeze({
    harness,
    origin: harness.origin,
    farmId: harness.farmId,
    printers: Object.freeze(seeded),
    owner: harness.ownerPage,
    signInAs,
    async openFarm(page: Page = harness.ownerPage) {
      const response = await page.goto(harness.origin + '/farm', {
        waitUntil: 'domcontentloaded',
      })
      expect(response?.status()).toBe(200)
      await expect(
        page.getByRole('heading', { name: 'Minha farm', exact: true }),
      ).toBeVisible()
    },
    printerCard,
    blockedRequests: () => guard.blocked(),
    assertNoOutbound() {
      const blocked = guard.blocked()
      if (blocked.length)
        throw new Error(
          'Outbound requests were attempted:\n' + blocked.join('\n'),
        )
    },
  })
}

type Fixtures = {
  /** Boots the stack; closed and checked for outbound requests after the test. */
  bootFarm(options: BootOptions): Promise<FarmManager>
}

export const test = base.extend<Fixtures>({
  bootFarm: async ({ browser }, use, testInfo) => {
    const guard = createNetworkGuard()
    const closers: (() => Promise<void>)[] = []
    let booted: FarmManager | undefined
    await use(async (options) => {
      if (booted) throw new Error('One farm per test')
      testInfo.setTimeout(Math.max(testInfo.timeout, 10 * 60_000))
      try {
        booted = await bootFarm(browser, guard, options, (close) =>
          closers.push(close),
        )
      } catch (error) {
        console.error('Farm boot failed')
        throw error
      }
      return booted
    })
    const failures: string[] = []
    for (const close of closers.splice(0).reverse())
      try {
        await close()
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    // A request outside loopback fails the test even when the page coped.
    const blocked = guard.blocked()
    if (blocked.length)
      throw new Error(
        'Outbound requests were attempted:\n' + blocked.join('\n'),
      )
    if (failures.length)
      throw new Error('Cleanup failed: ' + failures.join('; '))
  },
})

export { expect }

/** Default instant for visual and a11y journeys: fixed, pt-BR timezone day. */
export const FROZEN_INSTANT = '2026-01-15T12:00:00-03:00'

/**
 * Freezes `Date.now()`/`new Date()` in every page of the context. Timers keep
 * running, so hydration and live telemetry are unaffected. Call before the
 * first navigation.
 */
export async function freezeClock(
  target: Page | BrowserContext,
  instant: string | number | Date = FROZEN_INSTANT,
): Promise<void> {
  const context = 'context' in target ? target.context() : target
  await context.clock.setFixedTime(new Date(instant))
}

export type Theme = 'light' | 'dark'

/**
 * Selects the farm theme as a person would (stored choice plus the browser
 * color scheme) for the page's context. Applies at once to a page already on
 * the app and to every later navigation.
 */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme })
  await page.context().addInitScript((value: Theme) => {
    try {
      localStorage.setItem('farm-theme', value)
    } catch {
      /* Storage can be unavailable; the media query still applies. */
    }
  }, theme)
  if (/^https?:/.test(page.url()))
    await page.evaluate((value: Theme) => {
      try {
        localStorage.setItem('farm-theme', value)
      } catch {
        /* See above. */
      }
      document.documentElement.dataset.theme = value
    }, theme)
}
