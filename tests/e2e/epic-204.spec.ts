import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpsRequest } from 'node:https'
import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'
import { z } from 'zod'
import { IntegrationClient } from '../../examples/integration-client/client.ts'
import { openApiDocumentFromYaml } from '../../apps/farm/server/utils/integrations/openapi-spec.ts'
import { startJourneyHarness } from '../journey/harness.ts'

const SPEC_PATH = new URL('../../docs/api/openapi-v1.yaml', import.meta.url)
const registeredApp = z.object({
  app: z.object({ id: z.string().uuid() }),
  credential: z.object({ clientId: z.string() }),
  secret: z.string(),
})
const registeredGrant = z.object({
  grant: z.object({ id: z.string().uuid() }),
})

test('published integration spec covers start, pause and cancel', async ({
  request,
}) => {
  const source = await readFile(SPEC_PATH, 'utf8')
  const document = openApiDocumentFromYaml(source) as {
    openapi: string
    paths: Record<string, Record<string, { operationId?: string }>>
  }
  expect(document.openapi).toBe('3.1.0')
  expect(document.paths['/printers/{printerId}/jobs']?.post?.operationId).toBe(
    'submitJob',
  )
  expect(
    document.paths['/printers/{printerId}/actions']?.post?.operationId,
  ).toBe('submitAction')
  expect(document.paths['/jobs/{jobId}']?.get?.operationId).toBe('getJob')
  expect(document.paths['/actions/{actionId}']?.get?.operationId).toBe(
    'getAction',
  )
  expect(source).toContain('jobs:start')
  expect(source).toContain('control:basic')

  const published = await request.get('/api/integrations/v1/openapi.json')
  expect(published.ok()).toBe(true)
  expect(await published.json()).toEqual(document)
})

test('reference client starts, pauses and cancels a simulated print', async ({
  browser,
}, testInfo) => {
  test.setTimeout(15 * 60_000)
  process.env.OPENFARM_JOURNEY = '1'
  process.env.OPENFARM_JOURNEY_INTEGRATION_API = '1'
  let startedJourney:
    Awaited<ReturnType<typeof startJourneyHarness>> | undefined
  let files: Awaited<ReturnType<typeof startPrintFileServer>> | undefined
  try {
    const journey = await startJourneyHarness({
      browser,
      simulator: 'moonraker-fixture',
      signedControl: true,
      moonraker: { initial: { state: 'standby', progress: 0 } },
    })
    startedJourney = journey
    await expect
      .poll(() => journey.simulatorObservation().pauseInboxReady, {
        timeout: 60_000,
      })
      .toBe(true)
    const stateUrl = process.env.OPENFARM_JOURNEY_STATE_URL
    const certificatePath = process.env.OPENFARM_JOURNEY_CERT
    const certificateKeyPath = process.env.OPENFARM_JOURNEY_CERT_KEY
    if (!stateUrl || !certificatePath || !certificateKeyPath)
      throw new Error('Integration journey did not publish its sandbox')
    await publishControls({
      url: stateUrl,
      farmId: journey.farmId,
      agentId: journey.agentId,
      printerKey: journey.printerKey,
      controls: ['pause', 'resume', 'cancel', 'start_print'],
    })

    const app = registeredApp.parse(
      await ownerPost(
        journey.ownerPage,
        `/api/farms/${journey.farmId}/integrations/apps`,
        {
          name: 'Journey API',
          sandbox: true,
        },
      ),
    )
    registeredGrant.parse(
      await ownerPost(
        journey.ownerPage,
        `/api/farms/${journey.farmId}/integrations/apps/${app.app.id}/grants`,
        {
          printerAssignmentId: journey.assignmentId,
          scopes: ['jobs:read', 'control:basic', 'plates:confirm'],
        },
      ),
    )

    registeredGrant.parse(
      await ownerPost(
        journey.ownerPage,
        `/api/farms/${journey.farmId}/integrations/apps/${app.app.id}/grants`,
        {
          printerAssignmentId: journey.assignmentId,
          scopes: ['jobs:start'],
          requiresApproval: true,
        },
      ),
    )

    const certificate = await readFile(certificatePath)
    files = await startPrintFileServer(
      certificate,
      await readFile(certificateKeyPath),
    )
    const client = new IntegrationClient(
      journey.origin,
      app.credential.clientId,
      app.secret,
      loopbackFetcher(journey.origin, certificate),
    )
    await client.authenticate([
      'jobs:read',
      'jobs:start',
      'control:basic',
      'plates:confirm',
    ])

    const job = await client.startPrint(
      journey.assignmentId,
      {
        fileUrl: files.url,
        sha256: files.sha256,
        sizeBytes: files.sizeBytes,
        displayName: 'journey.gcode',
      },
      'journey-start',
    )
    expect(job.status).toBe('held')
    const eligibility = await client.request<{ plate: { attemptId?: string } }>(
      `jobs/${job.id}/eligibility?printerId=${journey.assignmentId}`,
    )
    const attempt = eligibility.plate.attemptId
    expect(attempt).toBeDefined()
    const clearance = await client.request<{ id: string }>(
      `jobs/${job.id}/actions`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'journey-initial-clearance' },
        body: JSON.stringify({
          action: 'confirm_collection',
          args: { attempt },
        }),
      },
    )
    await expect
      .poll(async () => (await client.getAction(clearance.id)).status, {
        timeout: 60_000,
      })
      .toBe('completed')
    await ownerPost(
      journey.ownerPage,
      `/api/farms/${journey.farmId}/integrations/approvals/${job.id}/decision`,
      { decision: 'approve' },
    )
    await expect
      .poll(
        async () => {
          const current = await client.getJob(job.id)
          if (current.status === 'refused') {
            const { refusal } = current as typeof current & {
              refusal?: { code: string; detail?: string }
            }
            throw new Error(
              `Simulator start refused: ${refusal?.code ?? 'unknown'} (${refusal?.detail ?? 'no detail'})`,
            )
          }
          return current.status
        },
        { timeout: 60_000 },
      )
      .toBe('started')
    await expect
      .poll(() => journey.printer.model().state, { timeout: 15_000 })
      .toBe('printing')

    const pause = await client.pausePrint(journey.assignmentId, 'journey-pause')
    await expect
      .poll(() => journey.printer.model().state, { timeout: 60_000 })
      .toBe('paused')
    await expect
      .poll(async () => (await client.getAction(pause.id)).status, {
        timeout: 60_000,
      })
      .toBe('completed')

    const cancel = await client.cancelPrint(
      journey.assignmentId,
      'journey-cancel',
    )
    await expect
      .poll(() => journey.printer.model().state, { timeout: 60_000 })
      .toBe('cancelled')
    await expect
      .poll(async () => (await client.getAction(cancel.id)).status, {
        timeout: 60_000,
      })
      .toBe('completed')

    expect(journey.printer.calls()).toMatchObject({
      'printer.print.start': 1,
      'printer.print.pause': 1,
      'printer.print.cancel': 1,
    })
    expect(journey.simulatorObservation().failure).toBe(false)
    await testInfo.attach('integration-api-simulator-evidence.json', {
      body: JSON.stringify(
        {
          simulator: 'moonraker-fixture',
          jobStatus: (await client.getJob(job.id)).status,
          pauseStatus: (await client.getAction(pause.id)).status,
          cancelStatus: (await client.getAction(cancel.id)).status,
          finalPrinterState: journey.printer.model().state,
          moonrakerCalls: journey.printer.calls(),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    })
  } catch (error) {
    if (startedJourney)
      console.error(
        JSON.stringify(startedJourney.simulatorObservation()),
        startedJourney.appLog(),
      )
    throw error
  } finally {
    await files?.close()
    await startedJourney?.close()
    delete process.env.OPENFARM_JOURNEY
    delete process.env.OPENFARM_JOURNEY_INTEGRATION_API
    delete process.env.OPENFARM_JOURNEY_STATE_URL
    delete process.env.OPENFARM_JOURNEY_CERT
    delete process.env.OPENFARM_JOURNEY_CERT_KEY
    delete process.env.SIGNALLING_HTTPS_API_ENVELOPE_PUBLIC_KEY
    delete process.env.SIGNALLING_HTTPS_API_ENVELOPE_KID
  }
})

test('a jobs:start grant without approval directly starts on a cleared simulator', async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000)
  process.env.OPENFARM_JOURNEY = '1'
  process.env.OPENFARM_JOURNEY_INTEGRATION_API = '1'
  let startedJourney:
    Awaited<ReturnType<typeof startJourneyHarness>> | undefined
  let files: Awaited<ReturnType<typeof startPrintFileServer>> | undefined
  try {
    const journey = await startJourneyHarness({
      browser,
      simulator: 'moonraker-fixture',
      signedControl: true,
      moonraker: { initial: { state: 'standby', progress: 0 } },
    })
    startedJourney = journey
    await expect
      .poll(() => journey.simulatorObservation().pauseInboxReady, {
        timeout: 60_000,
      })
      .toBe(true)

    const stateUrl = process.env.OPENFARM_JOURNEY_STATE_URL
    const certificatePath = process.env.OPENFARM_JOURNEY_CERT
    const certificateKeyPath = process.env.OPENFARM_JOURNEY_CERT_KEY
    if (!stateUrl || !certificatePath || !certificateKeyPath)
      throw new Error('Integration journey did not publish its sandbox')
    await publishControls({
      url: stateUrl,
      farmId: journey.farmId,
      agentId: journey.agentId,
      printerKey: journey.printerKey,
      controls: ['pause', 'resume', 'cancel', 'start_print'],
    })

    const heldApp = registeredApp.parse(
      await ownerPost(
        journey.ownerPage,
        `/api/farms/${journey.farmId}/integrations/apps`,
        { name: 'Journey clearance setup', sandbox: true },
      ),
    )
    await ownerPost(
      journey.ownerPage,
      `/api/farms/${journey.farmId}/integrations/apps/${heldApp.app.id}/grants`,
      {
        printerAssignmentId: journey.assignmentId,
        scopes: ['jobs:read', 'jobs:start'],
        requiresApproval: true,
      },
    )
    await ownerPost(
      journey.ownerPage,
      `/api/farms/${journey.farmId}/integrations/apps/${heldApp.app.id}/grants`,
      {
        printerAssignmentId: journey.assignmentId,
        scopes: ['control:basic', 'plates:confirm'],
        requiresApproval: false,
      },
    )

    const certificate = await readFile(certificatePath)
    files = await startPrintFileServer(
      certificate,
      await readFile(certificateKeyPath),
    )
    const heldClient = new IntegrationClient(
      journey.origin,
      heldApp.credential.clientId,
      heldApp.secret,
      loopbackFetcher(journey.origin, certificate),
    )
    await heldClient.authenticate([
      'jobs:read',
      'jobs:start',
      'control:basic',
      'plates:confirm',
    ])
    const clearanceJob = await heldClient.startPrint(
      journey.assignmentId,
      {
        fileUrl: files.url,
        sha256: files.sha256,
        sizeBytes: files.sizeBytes,
        displayName: 'clearance.gcode',
      },
      'journey-clearance-seed',
    )
    expect(clearanceJob.status).toBe('held')
    const eligibility = await heldClient.request<{
      plate: { attemptId?: string }
    }>(`jobs/${clearanceJob.id}/eligibility?printerId=${journey.assignmentId}`)
    expect(eligibility.plate.attemptId).toBeDefined()
    const clearance = await heldClient.request<{ id: string }>(
      `jobs/${clearanceJob.id}/actions`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'journey-direct-start-clearance' },
        body: JSON.stringify({
          action: 'confirm_collection',
          args: { attempt: eligibility.plate.attemptId },
        }),
      },
    )
    await expect
      .poll(async () => (await heldClient.getAction(clearance.id)).status, {
        timeout: 60_000,
      })
      .toBe('completed')

    const directApp = registeredApp.parse(
      await ownerPost(
        journey.ownerPage,
        `/api/farms/${journey.farmId}/integrations/apps`,
        { name: 'Journey direct start', sandbox: true },
      ),
    )
    await ownerPost(
      journey.ownerPage,
      `/api/farms/${journey.farmId}/integrations/apps/${directApp.app.id}/grants`,
      {
        printerAssignmentId: journey.assignmentId,
        scopes: ['jobs:read', 'jobs:start'],
        requiresApproval: false,
      },
    )
    const directClient = new IntegrationClient(
      journey.origin,
      directApp.credential.clientId,
      directApp.secret,
      loopbackFetcher(journey.origin, certificate),
    )
    await directClient.authenticate(['jobs:read', 'jobs:start'])
    const job = await directClient.startPrint(
      journey.assignmentId,
      {
        fileUrl: files.url,
        sha256: files.sha256,
        sizeBytes: files.sizeBytes,
        displayName: 'direct-start.gcode',
      },
      'journey-direct-start',
    )
    expect(job.status).not.toBe('held')
    await expect
      .poll(
        async () => {
          const current = await directClient.getJob(job.id)
          if (current.status === 'refused')
            throw new Error('Simulator refused the direct job start')
          return current.status
        },
        { timeout: 60_000 },
      )
      .toBe('started')
    await expect
      .poll(() => journey.printer.model().state, { timeout: 15_000 })
      .toBe('printing')
    expect(journey.printer.calls()).toMatchObject({ 'printer.print.start': 1 })
    expect(journey.simulatorObservation().failure).toBe(false)
  } catch (error) {
    if (startedJourney)
      console.error(
        JSON.stringify(startedJourney.simulatorObservation()),
        startedJourney.appLog(),
      )
    throw error
  } finally {
    await files?.close()
    await startedJourney?.close()
    delete process.env.OPENFARM_JOURNEY
    delete process.env.OPENFARM_JOURNEY_INTEGRATION_API
    delete process.env.OPENFARM_JOURNEY_STATE_URL
    delete process.env.OPENFARM_JOURNEY_CERT
    delete process.env.OPENFARM_JOURNEY_CERT_KEY
    delete process.env.SIGNALLING_HTTPS_API_ENVELOPE_PUBLIC_KEY
    delete process.env.SIGNALLING_HTTPS_API_ENVELOPE_KID
  }
})

function loopbackFetcher(origin: string, ca: Buffer): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== origin || url.hostname !== '127.0.0.1')
      throw new Error('Integration journey requests must stay on loopback')
    const body = Buffer.from(await request.arrayBuffer())
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(
        url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ca,
          signal: request.signal,
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer | string) =>
            chunks.push(Buffer.from(chunk)),
          )
          incoming.on('error', reject)
          incoming.on('end', () => {
            const headers = new Headers()
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (typeof value === 'string') headers.set(name, value)
              else if (Array.isArray(value))
                for (const item of value) headers.append(name, item)
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode ?? 502,
                headers,
              }),
            )
          })
        },
      )
      outgoing.on('error', reject)
      if (body.byteLength > 0) outgoing.write(body)
      outgoing.end()
    })
  }
}

async function ownerPost(page: Page, path: string, body: unknown) {
  const result = await page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, text: await response.text() }
    },
    { path, body },
  )
  if (result.status >= 400)
    throw new Error(
      `Owner request ${path} failed (${result.status}): ${result.text.slice(0, 500)}`,
    )
  return JSON.parse(result.text) as unknown
}

async function publishControls(input: {
  url: string
  farmId: string
  agentId: string
  printerKey: string
  controls: readonly string[]
}) {
  const sql = postgres(input.url, { max: 1, connect_timeout: 3 })
  const receivedAt = Date.now()
  const observedAt = receivedAt + 20_000
  try {
    await sql`INSERT INTO farm.printer_latest_state
      (farm_id, agent_id, printer_key, observed_at, received_at, age_at_send_ms, state)
      VALUES (
        ${input.farmId}::uuid,
        ${input.agentId}::uuid,
        ${input.printerKey},
        ${observedAt},
        ${receivedAt},
        0,
        ${sql.json({
          printerKey: input.printerKey,
          state: 'idle',
          progress: 0,
          observedAt,
          controls: [...input.controls],
        })}::jsonb
      )
      ON CONFLICT (farm_id, agent_id, printer_key) DO UPDATE
      SET observed_at = EXCLUDED.observed_at, received_at = EXCLUDED.received_at, age_at_send_ms = EXCLUDED.age_at_send_ms, state = EXCLUDED.state
      WHERE farm.printer_latest_state.observed_at < EXCLUDED.observed_at`
  } finally {
    await sql.end({ timeout: 3 })
  }
}

async function startPrintFileServer(certificate: Buffer, key: Buffer) {
  const gcode = Buffer.from('G28\n')
  const server = createHttpsServer(
    { cert: certificate, key },
    (request, response) => {
      if (request.method !== 'GET' || request.url !== '/journey.gcode') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, {
        'content-length': String(gcode.byteLength),
        'content-type': 'application/octet-stream',
      })
      response.end(gcode)
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  return {
    url: `https://127.0.0.1:${address.port}/journey.gcode`,
    sha256: createHash('sha256').update(gcode).digest('hex'),
    sizeBytes: gcode.byteLength,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
