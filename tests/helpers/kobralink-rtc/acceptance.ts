import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import { loadOrCreateIdentity } from '../../../packages/connector/src/identity/store.ts'
import {
  PairingStartResponse,
  PairingPollResponse,
} from '../../../packages/farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../../packages/farm-protocol/src/pairing-proof.ts'
import {
  BrowserDeviceHttpChallengeResponse,
  BrowserDeviceHttpMutationResponse,
} from '../../../packages/farm-protocol/src/browser-device-http.ts'
import { browserBundle } from '../browser-bundle.ts'
import {
  bridgePrinterCount,
  collectSecrets,
  createChecks,
  createDatabaseAudit,
  readHarnessSecrets,
  runtimePrinterCount,
  type Checks,
  type DatabaseAudit,
  type HarnessSecrets,
} from './audit.ts'
import {
  createConnectorHost,
  writeConnectorFiles,
  type ConnectorHost,
} from './extension.ts'
import { instrumentPage, type PageObserver } from './observe.ts'
import {
  unexplainedConsoleIssues,
  type Secret,
  type World,
} from './qualification.ts'

export async function browserLogin(
  page: Page,
  origin: string,
  username: string,
  password: string,
) {
  await page.goto(origin + '/entrar', { timeout: 10000 })
  // Submitting before hydration posts the form natively (urlencoded) to the
  // JSON-only endpoint: 415, no session, and a later 401. Wait for the mounted
  // Vue app, as the other e2e specs do.
  await page.waitForFunction(
    () => {
      const root = document.querySelector('#__nuxt')
      return root !== null && '__vue_app__' in root
    },
    undefined,
    { timeout: 10000 },
  )
  await page.getByLabel('Usuário').fill(username)
  await page.getByLabel('Senha').fill(password)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  // Landing on an /api/ path means a native submission, never a login.
  await page.waitForURL(
    (url) => url.pathname !== '/entrar' && !url.pathname.startsWith('/api/'),
    { timeout: 10000 },
  )
}

/** Signs out through the real page, as a user switching accounts would. */
export async function browserLogout(page: Page, origin: string) {
  await page.goto(origin + '/sair', { timeout: 10000 })
  await page.waitForFunction(
    () => {
      const root = document.querySelector('#__nuxt')
      return root !== null && '__vue_app__' in root
    },
    undefined,
    { timeout: 10000 },
  )
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/', { timeout: 10000 })
}

export async function pagePost(
  page: Page,
  path: string,
  body: unknown,
): Promise<unknown> {
  return await page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok)
        throw new Error(`Synthetic browser HTTP rejected: ${response.status}`)
      return await response.json()
    },
    { path, body },
  )
}

/** Same-origin request from the page's own session; only the status returns. */
export async function pageStatus(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<number> {
  return await page.evaluate(
    async ({ method, path, body }) => {
      try {
        const response = await fetch(path, {
          method,
          headers:
            body === undefined ? {} : { 'content-type': 'application/json' },
          ...(body === undefined
            ? {}
            : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
          cache: 'no-store',
        })
        return response.status
      } catch {
        return 0
      }
    },
    { method, path, body },
  )
}

async function machinePost(
  origin: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok)
    throw new Error(`Synthetic machine HTTP rejected: ${response.status}`)
  return await response.json()
}

async function currentAccount(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/me')
    if (!response.ok) throw new Error('Fixture account lookup denied')
    const data: unknown = await response.json()
    if (
      !data ||
      typeof data !== 'object' ||
      !('accountId' in data) ||
      typeof data.accountId !== 'string'
    )
      throw new Error('Invalid fixture account')
    return data.accountId
  })
}

export type Enrolled = Readonly<{
  accountId: string
  keyId: string
  thumbprint: string
}>
export type Actor = Enrolled &
  Readonly<{
    username: string
    context: BrowserContext
    page: Page
    observer: PageObserver
  }>
export type Counts = Readonly<{
  assignments: number
  receipts: number
  operations: number
  bridgePrinters: number
  bridgeCreates: number
  bridgeDeletes: number
  runtimePrinters: number
  activated: number
}>

export type WorldContext = Readonly<{
  world: World
  origin: string
  farmId: string
  agentId: string
  root: string
  password: string
  usernames: Readonly<Record<'owner' | 'admin' | 'viewer' | 'member', string>>
  browser: Browser
  owner: Actor
  admin: Actor
  host: ConnectorHost
  db: DatabaseAudit
  checks: Checks
  harness: HarnessSecrets
  observers: PageObserver[]
  /** Expected refusals; anything else at or above 400 is unexpected. */
  allowHttp(method: string, path: RegExp, statuses: readonly number[]): void
  allowConsole(pattern: RegExp): void
  /** A further signed-in page with its own persisted, approved browser key. */
  actor(
    name: string,
    username: string,
    approver: Page,
    options?: { enroll?: boolean },
  ): Promise<Actor>
  observe(page: Page, label: string): Promise<PageObserver>
  /** Creates and approves a key for whoever is signed in on `page`. */
  enroll(page: Page, approver: Page): Promise<Enrolled>
  counts(): Promise<Counts>
  secrets(): Promise<Secret[]>
  disconnectSignalling(): Promise<void>
  revokeConnector(): Promise<void>
}>

type Allowed = { method: string; path: RegExp; statuses: readonly number[] }

/**
 * Real HTTPS login, browser-key registration, Connector pairing and the native
 * `configure` runtime, then one qualification world. Nothing in this chain is
 * stubbed: the pages, the session cookies, the database and the Connector are
 * the ones the built application serves.
 */
export async function runQualificationWorld(input: {
  world: World
  origin: string
  farmId: string
  usernames: WorldContext['usernames']
  password: string
  root: string
  databasePort: number
  kobraPort: number
  disconnectSignalling: () => Promise<void>
  run: (context: WorldContext) => Promise<void>
}) {
  const parsedOrigin = new URL(input.origin)
  if (
    parsedOrigin.origin !== input.origin ||
    parsedOrigin.protocol !== 'https:' ||
    parsedOrigin.hostname !== '127.0.0.1'
  )
    throw new Error('Fixture requires canonical HTTPS loopback')
  const audience = 'open3dfarmmanager:signalling'
  const t0 = performance.now()
  const stage = (name: string) => console.error(`[fixture-stage] ${name}`)
  const checks = createChecks(input.root, input.world)
  const harness = await readHarnessSecrets(input.root)
  const db = createDatabaseAudit(input.databasePort)
  const observers: PageObserver[] = []
  const allowed: Allowed[] = []
  const allowedConsole: RegExp[] = []
  let host: ConnectorHost | undefined
  stage('chromium-launch')
  const browser = await chromium.launch({ headless: true })
  let failed: unknown
  try {
    const bundle = await browserBundle(
      new URL('../signalling-rtc-browser.ts', import.meta.url).pathname,
      AbortSignal.timeout(30_000),
    )
    const observe = async (page: Page, label: string) => {
      const observer = await instrumentPage({
        page,
        label,
        evidence: input.root,
        origin: input.origin,
        t0,
      })
      observers.push(observer)
      return observer
    }
    const enroll = async (page: Page, approver: Page): Promise<Enrolled> => {
      const accountId = await currentAccount(page)
      const path = input.origin + '/__registration_fixture__.js'
      await page.route(path, (route) =>
        route.fulfill({ contentType: 'text/javascript', body: bundle }),
      )
      const actor = await page.evaluateHandle(
        async ({ path, scope }) => {
          const module: typeof import('../signalling-rtc-browser.ts') =
            await import(path)
          return module.createSignallingRtcBrowserActor(scope)
        },
        {
          path,
          scope: {
            accountId,
            farmId: input.farmId,
            origin: input.origin,
            audience,
            persistKey: true,
          },
        },
      )
      try {
        const jwk = await actor.evaluate((a) => a.publicJwk)
        const challenge = BrowserDeviceHttpChallengeResponse.parse(
          await pagePost(page, '/api/browser-devices/challenges', {
            farm_id: input.farmId,
            public_key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
          }),
        ).challenge
        const signature = await actor.evaluate(
          (a, c) => a.signEnrollment(c),
          challenge,
        )
        BrowserDeviceHttpMutationResponse.parse(
          await pagePost(page, '/api/browser-devices/proofs', {
            challenge_id: challenge.challenge_id,
            signature,
          }),
        )
        BrowserDeviceHttpMutationResponse.parse(
          await pagePost(approver, '/api/browser-devices/approve', {
            farm_id: input.farmId,
            key_id: challenge.key_id,
            expected_thumbprint: challenge.thumbprint,
          }),
        )
        return {
          accountId,
          keyId: challenge.key_id,
          thumbprint: challenge.thumbprint,
        }
      } finally {
        await actor.evaluate((a) => a.close()).catch(() => {})
        await actor.dispose().catch(() => {})
        await page.unroute(path)
      }
    }
    // The synthetic browser trusts its private test certificate; the native
    // Connector validates the supplied CA.
    const signIn = async (name: string, username: string) => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      const observer = await observe(page, name)
      await browserLogin(page, input.origin, username, input.password)
      return { username, context, page, observer }
    }
    stage('owner-login')
    const ownerSession = await signIn('owner', input.usernames.owner)
    stage('admin-login')
    const adminSession = await signIn('admin', input.usernames.admin)
    stage('browser-registration')
    const owner: Actor = {
      ...ownerSession,
      ...(await enroll(ownerSession.page, adminSession.page)),
    }
    const admin: Actor = {
      ...adminSession,
      ...(await enroll(adminSession.page, ownerSession.page)),
    }
    stage('connector-pairing')
    const dataDirectory = join(input.root, 'identity')
    await mkdir(dataDirectory, { mode: 0o700 })
    const identity = loadOrCreateIdentity(dataDirectory)
    const started = PairingStartResponse.parse(
      await machinePost(input.origin, '/api/connector-pairing/start', {
        public_key_spki: identity.publicKeySpki,
        platform: 'linux',
        version: '0.0.1',
      }),
    )
    const pairing = PairingProofChallenge.parse(
      await machinePost(input.origin, '/api/connector-pairing/challenge', {
        device_code: started.device_code,
      }),
    )
    await machinePost(input.origin, '/api/connector-pairing/proof', {
      device_code: started.device_code,
      challenge: pairing,
      signature: identity.signPairingProof({
        challenge: pairing,
        expectedOrigin: input.origin,
        expectedAudience: audience,
        now: Date.now(),
      }),
    })
    await pagePost(owner.page, '/api/connector-pairing/approve', {
      user_code: started.user_code,
      farm_id: input.farmId,
      expected_fingerprint: identity.fingerprint,
    })
    const claim = PairingPollResponse.parse(
      await machinePost(input.origin, '/api/connector-pairing/claim', {
        device_code: started.device_code,
      }),
    )
    if (claim.status !== 'approved' || claim.farm_id !== input.farmId)
      throw new Error('Synthetic pairing did not complete')
    const files = await writeConnectorFiles({
      root: input.root,
      origin: input.origin,
      audience,
      farmId: input.farmId,
      fingerprint: identity.fingerprint,
      claim,
      kobraPort: input.kobraPort,
    })
    stage('connector-start')
    const connector = createConnectorHost({
      root: input.root,
      origin: input.origin,
      dataDirectory,
      t0,
      ...files,
    })
    host = connector
    connector.start()
    const context: WorldContext = {
      world: input.world,
      origin: input.origin,
      farmId: input.farmId,
      agentId: claim.agent_id,
      root: input.root,
      password: input.password,
      usernames: input.usernames,
      browser,
      owner,
      admin,
      host: connector,
      db,
      checks,
      harness,
      observers,
      allowHttp: (method, path, statuses) => {
        allowed.push({ method, path, statuses })
      },
      allowConsole: (pattern) => {
        allowedConsole.push(pattern)
      },
      observe,
      enroll,
      async actor(name, username, approver, options) {
        const session = await signIn(name, username)
        const enrolled =
          options?.enroll === false
            ? {
                accountId: await currentAccount(session.page),
                keyId: '',
                thumbprint: '',
              }
            : await enroll(session.page, approver)
        return { ...session, ...enrolled }
      },
      async counts() {
        const rows = await db.counts(input.farmId)
        return {
          ...rows,
          bridgePrinters: await bridgePrinterCount(harness.bridgeContainer),
          bridgeCreates: connector.bridgeCalls('POST', /^\/api\/v1\/printers$/),
          bridgeDeletes: connector.bridgeCalls(
            'DELETE',
            /^\/api\/v1\/printers\//,
          ),
          runtimePrinters: await runtimePrinterCount(input.root),
          activated: connector.count(
            (event) =>
              event.kind === 'runtime-activation' &&
              event.result === 'activated',
          ),
        }
      },
      secrets: () =>
        collectSecrets({
          root: input.root,
          harness,
          kobraPort: input.kobraPort,
        }),
      disconnectSignalling: input.disconnectSignalling,
      async revokeConnector() {
        await pagePost(
          owner.page,
          `/api/farms/${input.farmId}/connectors/${claim.agent_id}/revoke`,
          { expected_fingerprint: identity.fingerprint },
        )
      },
    }
    stage(`world-${input.world}`)
    try {
      await input.run(context)
    } catch (error) {
      failed = error
      console.error(error)
      for (const observer of observers)
        await observer.page
          .screenshot({
            path: join(input.root, `failure-${observer.label}.png`),
            fullPage: true,
          })
          .catch(() => {})
    }
    stage('browser-evidence-audit')
    const secrets = await context.secrets()
    const found = {
      responses: new Set<string>(),
      storage: new Set<string>(),
      console: new Set<string>(),
      dom: new Set<string>(),
      websocket: new Set<string>(),
    }
    let responses = 0
    let frames = 0
    let truncated = false
    const uninspected: string[] = []
    let unread = 0
    let aborted = 0
    let bodyless = 0
    let read = 0
    for (const observer of observers) {
      const scan = await observer.scan(secrets)
      if (!scan.inspected) uninspected.push(observer.label)
      unread += scan.unread
      aborted += scan.aborted
      bodyless += scan.bodyless
      read += scan.read
      for (const key of [
        'responses',
        'storage',
        'console',
        'dom',
        'websocket',
      ] as const)
        for (const label of scan[key]) found[key].add(label)
      responses += scan.retainedResponses
      frames += scan.retainedFrames
      truncated ||= scan.truncated
    }
    const q = 'browser_secrets_absent'
    const connectorSecrets = secrets.filter(
      (secret) =>
        !secret.label.startsWith('bridge:') &&
        !secret.label.startsWith('printer:'),
    ).length
    await checks.record(
      q,
      'secret-set-non-empty',
      secrets.length >= 4 && !truncated,
      `secrets=${secrets.length} connector-state=${connectorSecrets} responses=${responses} frames=${frames} truncated=${truncated}`,
    )
    await checks.record(
      q,
      'browser-inspection-complete',
      uninspected.length === 0 && unread === 0 && !truncated,
      `pages=${observers.length} storage/DOM unread on: ${uninspected.join(',') || 'none'}; response bodies read: ${read}; unread: ${unread}; bodyless by protocol: ${bodyless}; aborted by the browser before completion: ${aborted}`,
    )
    for (const key of [
      'responses',
      'storage',
      'console',
      'dom',
      'websocket',
    ] as const)
      await checks.record(
        q,
        `${key}-clean`,
        found[key].size === 0,
        found[key].size ? [...found[key]].join(',') : `searched ${key}`,
      )
    const httpIssues = observers.flatMap((observer) => observer.httpIssues)
    const unexpectedHttp = httpIssues.filter(
      (issue) =>
        !allowed.some(
          (rule) =>
            rule.method === issue.method &&
            rule.path.test(issue.path) &&
            rule.statuses.includes(issue.status),
        ),
    )
    const failedRequests = observers.flatMap(
      (observer) => observer.failedRequests,
    )
    // Client-side aborts of superseded loads are the only tolerated failures.
    const unexpectedFailed = failedRequests.filter(
      (entry) => entry.error !== 'net::ERR_ABORTED',
    )
    await checks.record(
      q,
      'no-unexpected-network-errors',
      unexpectedHttp.length === 0 && unexpectedFailed.length === 0,
      `http>=400: ${httpIssues.length} (unexpected ${unexpectedHttp
        .slice(0, 6)
        .map((i) => `${i.page} ${i.method} ${i.path} ${i.status}`)
        .join(
          '; ',
        )}); failed: ${failedRequests.length} (unexpected ${unexpectedFailed
        .slice(0, 6)
        .map((i) => `${i.page} ${i.method} ${i.path} ${i.error}`)
        .join('; ')})`,
    )
    const consoleIssues = observers.flatMap(
      (observer) => observer.consoleIssues,
    )
    // A close() the page itself made on a CONNECTING signalling socket
    // (superseded feed) explains exactly one matching Chromium warning.
    const closesWhileConnecting = observers.flatMap((observer) =>
      observer.diagnostics
        .filter((entry) => entry.event === 'ws-close-connecting')
        .map((entry) => ({ page: entry.page, path: entry.path ?? 'other' })),
    )
    const unpairedConsole = unexplainedConsoleIssues(
      consoleIssues,
      closesWhileConnecting,
    )
    // Chromium mirrors every HTTP error as a console error; those are judged above.
    const unexpectedConsole = unpairedConsole.filter(
      (issue) =>
        !/^Failed to load resource: the server responded with a status of/.test(
          issue.text,
        ) && !allowedConsole.some((pattern) => pattern.test(issue.text)),
    )
    await checks.record(
      q,
      'no-unexpected-console-errors',
      unexpectedConsole.length === 0,
      `console issues: ${consoleIssues.length}; page closes while connecting: ${closesWhileConnecting.length}, paired: ${consoleIssues.length - unpairedConsole.length} (unexpected ${unexpectedConsole
        .slice(0, 6)
        .map((i) => `${i.page} ${i.type} ${i.text.slice(0, 80)}`)
        .join('; ')})`,
    )
    await writeFile(
      join(input.root, 'browser-issues.json'),
      JSON.stringify({ httpIssues, failedRequests, consoleIssues }, null, 1),
      { mode: 0o600 },
    )
    const connectorFailure = connector.failure()
    if (connectorFailure && !failed) failed = connectorFailure
  } finally {
    try {
      await host?.dispose()
    } finally {
      await db.close().catch(() => {})
      await browser.close()
    }
  }
  if (failed) throw failed
  return { world: input.world, checks: checks.records.length }
}
