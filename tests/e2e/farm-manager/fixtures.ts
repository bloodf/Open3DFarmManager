// Shared base of the farm-manager journeys (#388 and the Phase 3b journeys).
// Boots the built farm app, database and Connector through the E16 journey
// harness (tests/journey/harness.ts), signs in the owner, and seeds mock
// printers of chosen families on loopback port 0. Every browser context the
// harness or the helpers create blocks any request outside 127.0.0.1 and
// localhost, and the test fails when one was attempted.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import { loadOrCreateIdentity } from '../../../packages/connector/src/identity/store.ts'
import {
  PairingPollResponse,
  PairingStartResponse,
} from '../../../packages/farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../../packages/farm-protocol/src/pairing-proof.ts'
import { AUDIENCE } from '../../journey/farm-app.ts'
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
import {
  startVendorSimulator,
  type VendorRuntime,
} from '../../journey/harness-vendors.ts'
import {
  startMoonrakerSimulator,
  type MoonrakerSimulator,
} from '../../journey/moonraker-simulator.ts'
import {
  startKobraXMock,
  type KobraXMockInstance,
} from '../../../packages/sim-tools/src/mocks/index.ts'

export type PrinterFamily =
  'moonraker' | 'bambu' | 'creality' | 'anycubic' | 'kobralink' | 'kobra-x'

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
  /** Optional grouping metadata applied via POST /printers/:id/grouping. */
  displayName?: string | null
  groupName?: string | null
  location?: string | null
  sortOrder?: number | null
}>

export type SeededPrinter = Readonly<{
  family: PrinterFamily
  printerKey: string
  assignmentId?: string
  agentId?: string
  /**
   * True when a Connector collects this printer, so the farm page shows live
   * telemetry. Single-printer boots and `connectAll: true` boots are live.
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
  /**
   * Pairs extra packaged Connector processes (batched by family, up to 4 per
   * Connector) so every seeded printer delivers live WebRTC status and
   * telemetry snapshots.
   */
  connectAll?: boolean
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
  kobralink: 'kobralink',
}

async function startSeedMock(
  family: PrinterFamily,
  printerKey: string,
  deviceId?: string,
): Promise<SeededPrinter['mock']> {
  if (family === 'moonraker') return startMoonrakerSimulator()
  if (family === 'kobra-x') return startKobraXMock({ reportIntervalMs: 0 })
  return startVendorSimulator(family as VendorName, {
    printerKey,
    ...(deviceId ? { deviceId } : {}),
  })
}

async function closeMock(mock: SeededPrinter['mock']) {
  if (mock && 'close' in mock) await mock.close()
}

function machinePostCa(origin: string, ca: Buffer) {
  return (path: string, body: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const payload = JSON.stringify(body)
      const request = httpsRequest(
        origin + path,
        {
          method: 'POST',
          ca,
          timeout: 5000,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            if (response.statusCode !== 200)
              reject(
                new Error(
                  `Connector batch HTTP rejected (${path}): ${response.statusCode}`,
                ),
              )
            else
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
              } catch (error) {
                reject(error)
              }
          })
        },
      )
      request.on('timeout', () => request.destroy(new Error('Timed out')))
      request.on('error', reject)
      request.end(payload)
    })
}

async function applyGrouping(
  ownerPage: Page,
  farmId: string,
  agentId: string,
  assignmentId: string,
  printerKey: string,
  seed: PrinterSeed,
) {
  if (
    seed.displayName === undefined &&
    seed.groupName === undefined &&
    seed.location === undefined &&
    seed.sortOrder === undefined
  )
    return
  await pagePost(
    ownerPage,
    `/api/farms/${farmId}/printers/${assignmentId}/grouping`,
    {
      agentId,
      printerKey,
      displayName: seed.displayName ?? null,
      groupName: seed.groupName ?? null,
      location: seed.location ?? null,
      sortOrder: seed.sortOrder ?? null,
    },
  )
}

function mergeVendorBatchConfig(
  family: VendorName,
  runtimes: readonly VendorRuntime[],
) {
  const first = runtimes[0]!
  if (family === 'kobralink') {
    const sections = runtimes.map(
      (r) =>
        r.collection.kobralink as {
          allowedOrigins: string[]
          printers: unknown[]
        },
    )
    return {
      version: 2 as const,
      collection: {
        version: 2,
        allowedOrigins: [],
        printers: [],
        kobralink: {
          allowedOrigins: [
            ...new Set(sections.flatMap((s) => s.allowedOrigins)),
          ],
          printers: sections.flatMap((s) => s.printers),
        },
        limits: { staleAfterMs: 5000 },
      },
      assignments: runtimes.map((r) => r.assignment),
    }
  }
  const key = family as 'bambu' | 'creality' | 'anycubic'
  return {
    version: first.version,
    collection: {
      version: first.version,
      allowedOrigins: [],
      printers: [],
      [key]: {
        printers: runtimes.flatMap(
          (r) => (r.collection[key] as { printers: unknown[] }).printers,
        ),
      },
      limits: { staleAfterMs: 5000 },
    },
    assignments: runtimes.map((r) => r.assignment),
  }
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
      'The first printer is the live one and must be moonraker, bambu, creality, anycubic or kobralink; Kobra X mocks are seeded after it',
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
  const seeded: (SeededPrinter | undefined)[] = Array.from({
    length: options.printers.length,
  })
  seeded[0] = {
    family: first.family,
    printerKey: keys[0]!,
    assignmentId: harness.assignmentId,
    agentId: harness.agentId,
    live: rest.length === 0 || options.connectAll === true,
    mock: harness.vendor ?? harness.printer,
  }
  onClose(() => harness.close())
  try {
    await applyGrouping(
      harness.ownerPage,
      harness.farmId,
      harness.agentId,
      harness.assignmentId,
      keys[0]!,
      first,
    )
    if (!options.connectAll) {
      // The harness configures the Connector for one printer. The others are
      // registered on the same paired Connector through the farm's own
      // assignment API and get their own loopback mock; the Connector does not
      // collect them, and registering them drops the direct connection.
      for (const [offset, seed] of rest.entries()) {
        const printerKey = keys[offset + 1]!
        const mock = await startSeedMock(seed.family, printerKey)
        onClose(() => closeMock(mock))
        const registered = (await pagePost(
          harness.ownerPage,
          `/api/farms/${harness.farmId}/printers`,
          {
            agentId: harness.agentId,
            printerKey,
            confirmedLocalConfiguration: true,
          },
        )) as { assignmentId?: string }
        if (registered.assignmentId)
          await applyGrouping(
            harness.ownerPage,
            harness.farmId,
            harness.agentId,
            registered.assignmentId,
            printerKey,
            seed,
          )
        seeded[offset + 1] = {
          family: seed.family,
          printerKey,
          ...(registered.assignmentId
            ? { assignmentId: registered.assignmentId }
            : {}),
          agentId: harness.agentId,
          live: false,
          mock,
        }
      }
    } else if (rest.length > 0) {
      // Keep status snapshots comfortably below the 2048-byte WebRTC frame cap
      // by grouping remaining printers into per-family batches of at most 4.
      const caPath = process.env.NODE_EXTRA_CA_CERTS
      if (!caPath) throw new Error('Harness CA certificate path unavailable')
      const machinePost = machinePostCa(harness.origin, await readFile(caPath))
      const cliEntry = fileURLToPath(
        new URL('../../../packages/connector/dist/cli.js', import.meta.url),
      )
      const byFamily = new Map<
        Exclude<PrinterFamily, 'kobra-x'>,
        { index: number; seed: PrinterSeed; printerKey: string }[]
      >()
      for (const [offset, seed] of rest.entries()) {
        if (seed.family === 'kobra-x')
          throw new Error(
            'connectAll uses kobralink for Kobra X simulators, not kobra-x',
          )
        const list = byFamily.get(seed.family) ?? []
        list.push({ index: offset + 1, seed, printerKey: keys[offset + 1]! })
        byFamily.set(seed.family, list)
      }
      const batches: {
        family: Exclude<PrinterFamily, 'kobra-x'>
        items: { index: number; seed: PrinterSeed; printerKey: string }[]
      }[] = []
      for (const [family, items] of byFamily) {
        for (let i = 0; i < items.length; i += 4)
          batches.push({ family, items: items.slice(i, i + 4) })
      }
      for (const batch of batches) {
        const dir = await mkdtemp(join(tmpdir(), 'o3dfm-extra-conn-'))
        onClose(() => rm(dir, { recursive: true, force: true }))
        const dataDir = join(dir, 'data')
        const identity = loadOrCreateIdentity(dataDir)
        const started = PairingStartResponse.parse(
          await machinePost('/api/connector-pairing/start', {
            public_key_spki: identity.publicKeySpki,
            platform: 'linux',
            version: '0.0.1',
          }),
        )
        const pairing = PairingProofChallenge.parse(
          await machinePost('/api/connector-pairing/challenge', {
            device_code: started.device_code,
          }),
        )
        await machinePost('/api/connector-pairing/proof', {
          device_code: started.device_code,
          challenge: pairing,
          signature: identity.signPairingProof({
            challenge: pairing,
            expectedOrigin: harness.origin,
            expectedAudience: AUDIENCE,
            now: Date.now(),
          }),
        })
        await pagePost(harness.ownerPage, '/api/connector-pairing/approve', {
          user_code: started.user_code,
          farm_id: harness.farmId,
          expected_fingerprint: identity.fingerprint,
        })
        const claim = PairingPollResponse.parse(
          await machinePost('/api/connector-pairing/claim', {
            device_code: started.device_code,
          }),
        )
        if (claim.status !== 'approved' || claim.farm_id !== harness.farmId)
          throw new Error('Extra Connector pairing did not complete')

        const startedItems: {
          index: number
          seed: PrinterSeed
          printerKey: string
          assignmentId: string
          mock: SeededPrinter['mock']
        }[] = []
        for (const item of batch.items) {
          const mock = await startSeedMock(
            batch.family,
            item.printerKey,
            `p${item.index + 1}`,
          )
          onClose(() => closeMock(mock))
          const registered = (await pagePost(
            harness.ownerPage,
            `/api/farms/${harness.farmId}/printers`,
            {
              agentId: claim.agent_id,
              printerKey: item.printerKey,
              confirmedLocalConfiguration: true,
            },
          )) as { assignmentId?: unknown }
          if (typeof registered.assignmentId !== 'string')
            throw new Error('Extra printer assignment failed')
          await applyGrouping(
            harness.ownerPage,
            harness.farmId,
            claim.agent_id,
            registered.assignmentId,
            item.printerKey,
            item.seed,
          )
          startedItems.push({
            ...item,
            assignmentId: registered.assignmentId,
            mock,
          })
          seeded[item.index] = {
            family: item.seed.family,
            printerKey: item.printerKey,
            assignmentId: registered.assignmentId,
            agentId: claim.agent_id,
            live: true,
            mock,
          }
        }

        let runtimeBody: {
          version: number
          collection: Record<string, unknown>
          assignments: unknown[]
        }
        if (batch.family === 'moonraker') {
          const mocks = startedItems.map((i) => i.mock as MoonrakerSimulator)
          runtimeBody = {
            version: 1,
            collection: {
              version: 1,
              allowedOrigins: mocks.map((m) => m.origin),
              printers: startedItems.map((i, idx) => ({
                printerKey: i.printerKey,
                origin: mocks[idx]!.origin,
              })),
              limits: { staleAfterMs: 5000 },
            },
            assignments: startedItems.map((i, idx) => ({
              assignment_id: i.assignmentId,
              agent_id: claim.agent_id,
              farm_id: harness.farmId,
              printer_key: i.printerKey,
              moonraker_origin: mocks[idx]!.origin,
            })),
          }
        } else {
          const runtimes = await Promise.all(
            startedItems.map((i) =>
              (i.mock as VendorSimulator).runtime({
                farmId: harness.farmId,
                agentId: claim.agent_id,
                assignmentId: i.assignmentId,
                printerKey: i.printerKey,
              }),
            ),
          )
          runtimeBody = mergeVendorBatchConfig(batch.family, runtimes)
        }

        const configPath = join(dir, 'runtime.json')
        const credentialPath = join(dir, 'credential.json')
        await writeFile(
          configPath,
          JSON.stringify({
            ...runtimeBody,
            telemetry: {
              endpoint: harness.origin + '/api/connector/telemetry',
              audience: AUDIENCE,
              retryMinMs: 1000,
              retryMaxMs: 2000,
              idleMs: 2000,
            },
            signalling: {
              endpoint:
                harness.origin.replace('https:', 'wss:') +
                '/api/signalling/connector',
              origin: harness.origin,
              audience: AUDIENCE,
              retryMinMs: 1000,
              retryMaxMs: 1000,
            },
          }),
          { mode: 0o600, flag: 'wx' },
        )
        await writeFile(
          credentialPath,
          JSON.stringify({
            version: 1,
            expected_fingerprint: identity.fingerprint,
            approval: claim,
          }),
          { mode: 0o600, flag: 'wx' },
        )

        const child = spawn(
          process.execPath,
          [
            cliEntry,
            'run',
            '--config',
            configPath,
            '--credential-file',
            credentialPath,
            '--data-dir',
            dataDir,
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              NODE_OPTIONS: process.env.OPENFARM_NETWORK_GUARD_PRELOAD ?? '',
            },
          },
        )
        let stderrTail = ''
        child.stdout?.on('data', () => {})
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1500)
        })
        const exited = once(child, 'close')
        onClose(async () => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGTERM')
          await Promise.race([
            exited,
            new Promise<void>((resolve) => setTimeout(resolve, 6000).unref()),
          ])
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
            await Promise.race([
              exited,
              new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
            ])
            if (stderrTail) console.error('Extra Connector stderr:', stderrTail)
          }
        })
      }
    }
  } catch (error) {
    console.error(harness.appLog())
    throw error
  }
  const finalizedSeeded = seeded as SeededPrinter[]

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
    printers: Object.freeze(finalizedSeeded),
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
