// SPDX-License-Identifier: MIT
// `desktop:check` smoke step: the built farm app and the real Connector CLI run
// against loopback printer/Spoolman mocks and a throwaway local PostgreSQL
// cluster; while both are up this checks /healthz, /readyz and loads the farm
// page in system Chrome with every non-loopback host blocked at the browser.
// Read-only: no printer command is sent. Needs `npm run build` first.
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser } from '../tests/helpers/browser.ts'
import {
  disposablePostgres,
  getFreePort,
} from '../tests/helpers/disposable-postgres.ts'
import { mockSimulatorStack } from '../tests/helpers/sim-acceptance-mocks.ts'
import {
  runSimFarmAcceptance,
  simPorts,
} from '../tests/helpers/sim-farm-acceptance.ts'

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/

async function checkApp(live: {
  appOrigin: string
  connectorRunning: () => boolean
}) {
  assert.ok(live.connectorRunning(), 'Connector is running next to the app')
  for (const path of ['/healthz', '/readyz']) {
    const response = await fetch(live.appOrigin + path, {
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200, `${path} answers 200`)
  }
  const browser = await launchBrowser({
    args: [
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  })
  try {
    const page = await browser.newPage()
    const external: string[] = []
    page.on('request', (request) => {
      const { protocol, hostname } = new URL(request.url())
      if (/^https?:$/.test(protocol) && !LOOPBACK.test(hostname))
        external.push(request.url())
    })
    const response = await page.goto(live.appOrigin + '/farm', {
      waitUntil: 'load',
      timeout: 30_000,
    })
    assert.ok(response?.ok(), `farm page answers ${response?.status()}`)
    await page.locator('body').waitFor({ state: 'visible', timeout: 15_000 })
    assert.ok(
      (await page.locator('body').innerText()).trim().length > 0,
      'farm page renders text',
    )
    assert.deepEqual(
      external,
      [],
      'the farm page contacts no non-loopback host',
    )
    console.log(`SMOKE_PAGE: ${page.url()} (${await browser.version()})`)
  } finally {
    await browser.close()
  }
}

const workDir = await mkdtemp(join(tmpdir(), 'openfarm-desktop-smoke-'))
const ledgerPath = join(workDir, 'ledger.jsonl')
const ledger = (value: object) =>
  appendFileSync(ledgerPath, JSON.stringify(value) + '\n', { mode: 0o600 })
await access(new URL('../apps/farm/.output/server/index.mjs', import.meta.url))
const ports = simPorts(0)
ports.db = await getFreePort()
ports.app = await getFreePort()
ports.proxy = await getFreePort()
const database = disposablePostgres({
  isolated: true,
  name: 'desktop-check-smoke',
  labelKey: 'org.open3dfarmmanager.desktop-check',
  labelValue: 'smoke',
  port: ports.db,
  ledger,
})
const mocks = mockSimulatorStack()
let failure: unknown
try {
  await mocks.up()
  const admin = await database.start()
  const report = await runSimFarmAcceptance({
    admin,
    ports,
    workDir,
    ledger,
    origins: mocks.origins,
    whileRunning: checkApp,
  })
  console.log(`SMOKE_OK: telemetry ${JSON.stringify(report.telemetryRows)}`)
} catch (error) {
  failure = error
} finally {
  await database.stop().catch((error) => (failure ??= error))
  await mocks.down().catch((error) => (failure ??= error))
  if (failure) console.error(`SMOKE_FAILED: evidence kept in ${workDir}`)
  else await rm(workDir, { recursive: true, force: true })
}
if (failure) {
  console.error(
    failure instanceof Error ? (failure.stack ?? failure.message) : failure,
  )
  process.exitCode = 1
}
