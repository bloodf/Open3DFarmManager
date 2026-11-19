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
  startDiscoveryMocks,
  startKobraXMock,
  type DiscoveryMockInstance,
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
  /** Which Connector hosts this printer (default: 1; 2 uses the secondary Connector). */
  connector?: 1 | 2
  /**
   * True to configure the Connector to collect live telemetry from this printer
   * when seeding multiple Moonraker printers or a second Connector.
   */
  live?: boolean
}>

export type SeededPrinter = Readonly<{
  family: PrinterFamily
  printerKey: string
  connector?: 1 | 2
  agentId?: string
  assignmentId?: string
  /**
   * True when the Connector collects this printer, so the farm page shows live
   * telemetry.
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
  /** Starts an unadopted Moonraker mock + loopback mDNS discovery responder on Connector 2. */
  discoveredMoonraker?: Readonly<{ name?: string }>
}>

export type FarmManager = Readonly<{
  harness: JourneyHarness
  origin: string
  farmId: string
  /** Paired Connector agent IDs in boot order (1, then 2 if started). */
  connectors: readonly string[]
  printers: readonly SeededPrinter[]
  /** Discovered-only Moonraker mock + mDNS name (`discoveredMoonraker`). */
  discovered?: Readonly<{
    name: string
    origin: string
    mock: MoonrakerSimulator
  }>
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
  if (first.connector === 2)
    throw new Error('The first printer must be hosted on Connector 1')
  process.env.OPENFARM_JOURNEY = '1'
  const keyOf = (seed: PrinterSeed, index: number) =>
    seed.printerKey ?? `${seed.family}-${index + 1}`
  const keys = options.printers.map(keyOf)
  if (new Set(keys).size !== keys.length)
    throw new Error('Printer keys must be unique')

  const liveExtras = new Map<string, MoonrakerSimulator>()
  const c1LivePrinters: { printerKey: string; origin: string }[] = []
  const c2LivePrinters: { printerKey: string; origin: string }[] = []
  for (const [offset, seed] of rest.entries()) {
    const printerKey = keys[offset + 1]!
    if (seed.connector === 2 && seed.live !== false) {
      if (seed.family !== 'moonraker')
        throw new Error('Connector 2 live printers currently require moonraker')
      const sim = await startMoonrakerSimulator()
      onClose(() => sim.close())
      liveExtras.set(printerKey, sim)
      c2LivePrinters.push({ printerKey, origin: sim.origin })
    } else if (seed.live === true) {
      if (seed.family !== 'moonraker')
        throw new Error(
          'Extra live printers on Connector 1 currently require moonraker',
        )
      if (first.family !== 'moonraker')
        throw new Error(
          'Multi-printer live Connector 1 requires moonraker as the first printer',
        )
      const sim = await startMoonrakerSimulator()
      onClose(() => sim.close())
      liveExtras.set(printerKey, sim)
      c1LivePrinters.push({ printerKey, origin: sim.origin })
    }
  }

  let discovered:
    | {
        name: string
        origin: string
        mock: MoonrakerSimulator
        discovery: DiscoveryMockInstance
      }
    | undefined
  if (options.discoveredMoonraker) {
    const mock = await startMoonrakerSimulator()
    onClose(() => mock.close())
    const name = options.discoveredMoonraker.name ?? 'moonraker-discovered'
    const discovery = await startDiscoveryMocks({
      vendors: ['moonraker'],
      moonraker: {
        name,
        port: Number(new URL(mock.origin).port),
      },
    })
    onClose(() => discovery.close())
    discovered = { name, origin: mock.origin, mock, discovery }
  }

  const harness = await startJourneyHarness({
    browser: guardedBrowser(browser, guard),
    simulator: HARNESS_SIMULATOR[first.family],
    printerKey: keys[0]!,
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.signedControl === undefined
      ? {}
      : { signedControl: options.signedControl }),
    ...(c1LivePrinters.length ? { extraPrinters: c1LivePrinters } : {}),
    ...(c2LivePrinters.length || discovered
      ? {
          secondaryConnector: {
            ...(c2LivePrinters.length
              ? { initialPrinters: c2LivePrinters }
              : {}),
            ...(discovered
              ? { probes: { discovery: discovered.discovery.discoveryOptions } }
              : {}),
          },
        }
      : {}),
  })
  onClose(() => harness.close())

  const secondaryAssignments = new Map(
    (harness.configurator?.assignments ?? []).map((item) => [
      item.printerKey,
      item,
    ]),
  )
  const uncollectedC1 = rest.some(
    (seed, offset) =>
      seed.connector !== 2 && !liveExtras.has(keys[offset + 1]!),
  )
  const seeded: SeededPrinter[] = [
    {
      family: first.family,
      printerKey: keys[0]!,
      connector: 1,
      agentId: harness.agentId,
      assignmentId: harness.assignmentId,
      live: !uncollectedC1,
      mock: harness.vendor ?? harness.printer,
    },
  ]
  try {
    for (const [offset, seed] of rest.entries()) {
      const printerKey = keys[offset + 1]!
      const liveMock = liveExtras.get(printerKey)
      if (liveMock) {
        if (seed.connector === 2) {
          const item = secondaryAssignments.get(printerKey)
          if (!item)
            throw new Error(`Missing secondary assignment for ${printerKey}`)
          seeded.push({
            family: seed.family,
            printerKey,
            connector: 2,
            agentId: item.agentId,
            assignmentId: item.assignmentId,
            live: true,
            mock: liveMock,
          })
        } else {
          seeded.push({
            family: seed.family,
            printerKey,
            connector: 1,
            agentId: harness.agentId,
            live: true,
            mock: liveMock,
          })
        }
        continue
      }
      const targetConnector = seed.connector ?? 1
      const targetAgentId =
        targetConnector === 2 ? harness.configurator?.agentId : harness.agentId
      if (!targetAgentId)
        throw new Error('Secondary Connector is not running for assignment')
      const mock = await startSeedMock(seed.family, printerKey)
      onClose(() => closeMock(mock))
      const created = (await pagePost(
        harness.ownerPage,
        `/api/farms/${harness.farmId}/printers`,
        {
          agentId: targetAgentId,
          printerKey,
          confirmedLocalConfiguration: true,
        },
      )) as { assignmentId?: unknown }
      seeded.push({
        family: seed.family,
        printerKey,
        connector: targetConnector,
        agentId: targetAgentId,
        ...(typeof created.assignmentId === 'string'
          ? { assignmentId: created.assignmentId }
          : {}),
        live: false,
        mock,
      })
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

  const connectors = harness.configurator
    ? Object.freeze([harness.agentId, harness.configurator.agentId])
    : Object.freeze([harness.agentId])

  return Object.freeze({
    harness,
    origin: harness.origin,
    farmId: harness.farmId,
    connectors,
    printers: Object.freeze(seeded),
    ...(discovered
      ? {
          discovered: Object.freeze({
            name: discovered.name,
            origin: discovered.origin,
            mock: discovered.mock,
          }),
        }
      : {}),
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
