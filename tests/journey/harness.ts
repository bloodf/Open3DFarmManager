// Opt-in journey harness (OPENFARM_JOURNEY=1). One call starts, on loopback
// only: a disposable PostgreSQL, the built farm app behind a TLS proxy, a
// Connector runtime and a named simulator; signs in; enrolls the browser;
// pairs the Connector; assigns the printer. Per-brand journey specs build on
// the returned handle. Never touches a physical printer.
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { expect, type Browser, type Page } from '@playwright/test'
import { browserBundle } from '../helpers/browser-bundle.ts'
import { browserLogin, pagePost } from '../helpers/kobralink-rtc/acceptance.ts'
import { createRuntimeMoonrakerFixture } from '../helpers/signalling-runtime-moonraker.ts'
import type { createSignallingRtcBrowserActor } from '../helpers/signalling-rtc-browser.ts'
import {
  PairingPollResponse,
  PairingStartResponse,
} from '../../packages/farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../packages/farm-protocol/src/pairing-proof.ts'
import {
  BrowserDeviceHttpChallengeResponse,
  BrowserDeviceHttpMutationResponse,
} from '../../packages/farm-protocol/src/browser-device-http.ts'
import {
  startMoonrakerSimulator,
  type MoonrakerSimulator,
} from './moonraker-simulator.ts'
import { startJourneyDatabase, type JourneyDatabase } from './database.ts'
import { AUDIENCE, startFarmApp, type FarmApp } from './farm-app.ts'

/**
 * Simulators the harness can stand in front of the Connector. The Moonraker
 * fixture is the only one wired so far; a brand adds its entry here.
 */
export type SimulatorName = 'moonraker-fixture'
export const SIMULATORS: Readonly<Record<SimulatorName, string>> = {
  'moonraker-fixture':
    'Loopback read-only Moonraker (tests/journey/moonraker-simulator.ts): printing, 25 % progress, 210/60 °C, empty Spoolman',
}

export type JourneyOptions = Readonly<{
  /** Playwright browser (the `browser` fixture). */
  browser: Browser
  simulator?: SimulatorName
  printerKey?: string
}>

export type JourneyHarness = Readonly<{
  origin: string
  farmId: string
  simulator: SimulatorName
  printerKey: string
  assignmentId: string
  agentId: string
  browserKeyId: string
  accounts: Readonly<{
    owner: string
    admin: string
    viewer: string
    password: string
  }>
  /** The owner page: signed in, device key stored, on the origin. */
  ownerPage: Page
  /** A fresh page in the signed-in owner context. */
  newOwnerPage(): Promise<Page>
  /** A fresh browser context signed in as another account. */
  signInAs(role: 'admin' | 'viewer'): Promise<Page>
  /** Opens the farm view and returns the printer's article. */
  openFarm(page?: Page): Promise<ReturnType<Page['locator']>>
  /** Waits for the authenticated direct connection and a state on the row. */
  expectLiveTelemetry(page?: Page): Promise<void>
  /** Moves the simulated print from 25 % to 75 %. */
  advanceSimulator(): void
  /** The simulated printer: change its state, read what it was asked. */
  printer: MoonrakerSimulator
  simulatorObservation(): ReturnType<
    Awaited<ReturnType<typeof createRuntimeMoonrakerFixture>>['observe']
  >
  /** Drops the browser↔app WebSocket upgrades, as a network loss would. */
  disconnectSignalling(): Promise<void>
  /** Bounded Nitro output tail for failure diagnostics. */
  appLog(): string
  close(): Promise<void>
}>

type Actor = Awaited<ReturnType<typeof createSignallingRtcBrowserActor>>

const ENV_KEYS = [
  'SIGNALLING_HTTPS_RTC_RUNTIME',
  'SIGNALLING_HTTPS_RTC_PACKAGED',
  'WS_NO_BUFFER_UTIL',
  'WS_NO_UTF_8_VALIDATE',
  'NODE_EXTRA_CA_CERTS',
  'SIGNALLING_HTTPS_SIM_MOONRAKER',
  'SIGNALLING_HTTPS_SIM_SPOOLMAN',
] as const

export function journeyEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.OPENFARM_JOURNEY === '1'
}

/** Machine-to-app JSON POST, trusting only the fixture's own certificate. */
function machinePoster(origin: string, ca: Buffer) {
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
                  `Synthetic machine HTTP rejected: ${response.statusCode}`,
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

/** Removes every resource a failed start already created. */
type Undo = () => Promise<void>

export async function startJourneyHarness(
  options: JourneyOptions,
): Promise<JourneyHarness> {
  if (!journeyEnabled())
    throw new Error('The journey harness is opt-in: set OPENFARM_JOURNEY=1')
  const simulator = options.simulator ?? 'moonraker-fixture'
  if (!(simulator in SIMULATORS))
    throw new Error(`Unknown simulator "${simulator}"`)
  const printerKey = options.printerKey ?? `journey-${simulator}`
  const runId = randomUUID().slice(0, 8)
  const undo: Undo[] = []
  const savedEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  )
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      const failures: string[] = []
      for (const step of undo.splice(0).reverse())
        try {
          await step()
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      for (const key of ENV_KEYS)
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
      if (failures.length)
        throw new Error('Journey cleanup incomplete: ' + failures.join('; '))
    })())
  // A killed worker skips `close`: remove the labelled container regardless.
  const onExit = () => {
    try {
      execFileSync(
        'docker',
        ['rm', '--volumes', '--force', `o3dfm-journey-${runId}`],
        { timeout: 20_000, stdio: 'ignore' },
      )
    } catch {
      /* Already gone. */
    }
  }
  process.once('exit', onExit)
  undo.push(async () => {
    process.removeListener('exit', onExit)
  })
  try {
    const database: JourneyDatabase = await startJourneyDatabase(runId)
    undo.push(() => database.close())
    const app: FarmApp = await startFarmApp(database)
    undo.push(() => app.close())
    const { origin } = app

    // Native clients (Connector, machine calls) trust only this certificate.
    const machinePost = machinePoster(
      origin,
      await readFile(app.certificatePath),
    )
    Object.assign(process.env, {
      SIGNALLING_HTTPS_RTC_RUNTIME: 'yes',
      SIGNALLING_HTTPS_RTC_PACKAGED: 'yes',
      WS_NO_BUFFER_UTIL: '1',
      WS_NO_UTF_8_VALIDATE: '1',
      NODE_EXTRA_CA_CERTS: app.certificatePath,
    })
    // The Connector collects from this simulator (the runtime fixture's own
    // synthetic server predates the discovery/query protocol and stays idle).
    const printer = await startMoonrakerSimulator()
    undo.push(() => printer.close())
    Object.assign(process.env, {
      SIGNALLING_HTTPS_SIM_MOONRAKER: printer.origin,
      SIGNALLING_HTTPS_SIM_SPOOLMAN: printer.spoolmanOrigin,
    })
    const runtime = await createRuntimeMoonrakerFixture()
    undo.push(async () => {
      const pid = runtime.observe().packagedPid
      try {
        await runtime.close()
      } catch (error) {
        if (pid)
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* Already exited. */
          }
        throw error
      }
    })

    // Sign in (real login page) as owner and admin.
    const ownerContext = await options.browser.newContext({
      ignoreHTTPSErrors: true,
    })
    undo.push(() => ownerContext.close())
    const ownerPage = await ownerContext.newPage()
    await browserLogin(
      ownerPage,
      origin,
      database.owner.username,
      database.password,
    )
    const adminContext = await options.browser.newContext({
      ignoreHTTPSErrors: true,
    })
    undo.push(() => adminContext.close())
    const adminPage = await adminContext.newPage()
    await browserLogin(
      adminPage,
      origin,
      database.admin.username,
      database.password,
    )

    // Enroll the owner's browser key (stored exactly as the farm page reads it).
    const bundle = await browserBundle(
      new URL('../helpers/signalling-rtc-browser.ts', import.meta.url).pathname,
    )
    const route = origin + '/__journey_actor__.js'
    await ownerPage.route(route, (r) =>
      r.fulfill({ status: 200, contentType: 'text/javascript', body: bundle }),
    )
    const actor = await ownerPage.evaluateHandle(
      async ({ path, scope }) => {
        const module: typeof import('../helpers/signalling-rtc-browser.ts') =
          await import(path)
        return await module.createSignallingRtcBrowserActor(scope)
      },
      {
        path: route,
        scope: {
          accountId: database.owner.id,
          farmId: database.farmId,
          origin,
          audience: AUDIENCE,
          persistKey: true,
        },
      },
    )
    undo.push(async () => {
      await actor.evaluate((a: Actor) => a.close()).catch(() => {})
      await actor.dispose()
    })
    const jwk = await actor.evaluate((a: Actor) => a.publicJwk)
    const challenge = BrowserDeviceHttpChallengeResponse.parse(
      await pagePost(ownerPage, '/api/browser-devices/challenges', {
        farm_id: database.farmId,
        public_key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      }),
    ).challenge
    const signature = await actor.evaluate(
      (a: Actor, c) => a.signEnrollment(c),
      challenge,
    )
    BrowserDeviceHttpMutationResponse.parse(
      await pagePost(ownerPage, '/api/browser-devices/proofs', {
        challenge_id: challenge.challenge_id,
        signature,
      }),
    )
    BrowserDeviceHttpMutationResponse.parse(
      await pagePost(adminPage, '/api/browser-devices/approve', {
        farm_id: database.farmId,
        key_id: challenge.key_id,
        expected_thumbprint: challenge.thumbprint,
      }),
    )

    // Pair the Connector identity (same one the runtime will use).
    const identity = runtime.identity
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
        expectedOrigin: origin,
        expectedAudience: AUDIENCE,
        now: Date.now(),
      }),
    })
    await pagePost(ownerPage, '/api/connector-pairing/approve', {
      user_code: started.user_code,
      farm_id: database.farmId,
      expected_fingerprint: identity.fingerprint,
    })
    const claim = PairingPollResponse.parse(
      await machinePost('/api/connector-pairing/claim', {
        device_code: started.device_code,
      }),
    )
    if (claim.status !== 'approved' || claim.farm_id !== database.farmId)
      throw new Error('Connector pairing did not complete')

    // Assign the printer, then read the assignment back.
    const path = `/api/farms/${database.farmId}/printers`
    const registration = (await pagePost(ownerPage, path, {
      agentId: claim.agent_id,
      printerKey,
      confirmedLocalConfiguration: true,
    })) as { assignmentId?: unknown }
    if (typeof registration.assignmentId !== 'string')
      throw new Error('Printer assignment failed')
    const assignmentId = registration.assignmentId
    const assignment = { assignmentId, agentId: claim.agent_id, printerKey }
    await runtime.start({
      origin,
      audience: AUDIENCE,
      claim,
      assignmentRefs: [assignment],
    })

    const openFarm = async (page: Page = ownerPage) => {
      const response = await page.goto(origin + '/farm', {
        waitUntil: 'domcontentloaded',
      })
      expect(response?.status()).toBe(200)
      await expect(
        page.getByRole('heading', { name: 'Minha farm', exact: true }),
      ).toBeVisible()
      return page.getByRole('article').filter({
        has: page.getByRole('heading', { name: printerKey, exact: true }),
      })
    }
    const asRole = async (role: 'admin' | 'viewer') => {
      const context = await options.browser.newContext({
        ignoreHTTPSErrors: true,
      })
      undo.push(() => context.close())
      const page = await context.newPage()
      await browserLogin(
        page,
        origin,
        database[role].username,
        database.password,
      )
      return page
    }
    return Object.freeze({
      origin,
      farmId: database.farmId,
      simulator,
      printerKey,
      assignmentId,
      agentId: claim.agent_id,
      browserKeyId: challenge.key_id,
      accounts: Object.freeze({
        owner: database.owner.username,
        admin: database.admin.username,
        viewer: database.viewer.username,
        password: database.password,
      }),
      ownerPage,
      newOwnerPage: () => ownerContext.newPage(),
      signInAs: asRole,
      openFarm,
      async expectLiveTelemetry(page: Page = ownerPage) {
        const row = await openFarm(page)
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 30_000 })
        await expect(row.getByRole('progressbar')).toHaveAttribute(
          'value',
          '0.25',
        )
      },
      advanceSimulator: () => printer.update({ progress: 0.75 }),
      printer,
      simulatorObservation: () => runtime.observe(),
      disconnectSignalling: () => app.disconnectUpgrades(),
      appLog: () => app.log(),
      close,
    })
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
