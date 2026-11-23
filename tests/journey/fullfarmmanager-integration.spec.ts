import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { expect, request, test } from '@playwright/test'
import { z } from 'zod'
import { IntegrationClient } from '../../examples/integration-client/client.ts'
import { pagePost } from '../helpers/kobralink-rtc/acceptance.ts'
import { journeyEnabled, startJourneyHarness } from './harness.ts'

const FILE = 'integration-journey.gcode'
const registeredApp = z.object({
  app: z.object({ id: z.string().uuid() }),
  credential: z.object({ clientId: z.string() }),
  secret: z.string(),
})
const dispatchView = z.object({
  jobId: z.string(),
  printerId: z.string(),
  plate: z.object({ state: z.string(), attemptId: z.string().optional() }),
  eligible: z.boolean().optional(),
  reasons: z.array(z.string()).optional(),
})

async function serveGcode(certPath: string, keyPath: string) {
  const gcode = Buffer.from('G28\n')
  const server = createServer(
    { cert: await readFile(certPath), key: await readFile(keyPath) },
    (req, res) => {
      if (req.method !== 'GET' || req.url !== `/${FILE}`) {
        res.writeHead(404).end()
        return
      }
      res
        .writeHead(200, {
          'content-length': gcode.byteLength,
          'content-type': 'application/octet-stream',
        })
        .end(gcode)
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('G-code server did not bind')
  return {
    file: {
      fileUrl: `https://127.0.0.1:${address.port}/${FILE}`,
      sha256: createHash('sha256').update(gcode).digest('hex'),
      sizeBytes: gcode.byteLength,
      displayName: FILE,
    },
    async close() {
      server.close()
      server.closeAllConnections()
      await once(server, 'close')
    },
  }
}

test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 })

if (journeyEnabled())
  test('jornada FullFarmManager: trabalho da API, histórico e confirmação da placa', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const envKeys = [
      'OPENFARM_JOURNEY_INTEGRATION_API',
      'OPENFARM_JOURNEY_STATE_URL',
      'OPENFARM_JOURNEY_CERT',
      'OPENFARM_JOURNEY_CERT_KEY',
      'SIGNALLING_HTTPS_API_ENVELOPE_PUBLIC_KEY',
      'SIGNALLING_HTTPS_API_ENVELOPE_KID',
    ] as const
    const saved = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]]),
    )
    process.env.OPENFARM_JOURNEY_INTEGRATION_API = '1'
    let journey: Awaited<ReturnType<typeof startJourneyHarness>> | undefined
    let files: Awaited<ReturnType<typeof serveGcode>> | undefined
    let http: Awaited<ReturnType<typeof request.newContext>> | undefined
    try {
      journey = await startJourneyHarness({
        browser,
        signedControl: true,
        moonraker: { initial: { state: 'standby', progress: 0, filename: '' } },
      })
      const started = journey
      await expect
        .poll(() => started.simulatorObservation().pauseInboxReady, {
          timeout: 60_000,
        })
        .toBe(true)
      await expect
        .poll(() => started.simulatorObservation().listening, {
          timeout: 60_000,
        })
        .toBeGreaterThan(0)
      const { ownerPage, origin, farmId, assignmentId, printer } = journey
      const cert = process.env.OPENFARM_JOURNEY_CERT
      const key = process.env.OPENFARM_JOURNEY_CERT_KEY
      if (!cert || !key)
        throw new Error('Integration harness did not expose its TLS fixture')
      files = await serveGcode(cert, key)
      const ownerPath = `/api/farms/${farmId}/integrations`
      const app = registeredApp.parse(
        await pagePost(ownerPage, `${ownerPath}/apps`, {
          name: 'FullFarmManager Journey',
          sandbox: true,
        }),
      )
      const grants = `${ownerPath}/apps/${app.app.id}/grants`
      // History uses jobs:read. A separate approval grant for jobs:start holds
      // the job while the operator-established initial clearance is recorded.
      const scopes = [
        'printers:read',
        'jobs:read',
        'jobs:start',
        'plates:confirm',
      ]
      await pagePost(ownerPage, grants, {
        printerAssignmentId: assignmentId,
        scopes: ['printers:read', 'jobs:read', 'plates:confirm'],
      })
      await pagePost(ownerPage, grants, {
        printerAssignmentId: assignmentId,
        scopes: ['jobs:start'],
        requiresApproval: true,
      })

      const loopback = await request.newContext({ ignoreHTTPSErrors: true })
      http = loopback
      const client = new IntegrationClient(
        origin,
        app.credential.clientId,
        app.secret,
        async (input, init) => {
          const req = new Request(input, init)
          if (new URL(req.url).origin !== origin)
            throw new Error('Integration request left the loopback farm')
          const result = await loopback.fetch(req.url, {
            method: req.method,
            headers: Object.fromEntries(req.headers),
            ...(req.body ? { data: Buffer.from(await req.arrayBuffer()) } : {}),
            maxRedirects: 0,
          })
          const body = await result.body()
          if (result.status() >= 400)
            throw new Error(
              `${req.method} ${new URL(req.url).pathname} returned ${result.status()} ${body.toString('utf8').slice(0, 300)}`,
            )
          return new Response(Uint8Array.from(body), {
            status: result.status(),
            headers: result.headers(),
          })
        },
      )
      await client.authenticate(scopes)
      const job = await client.startPrint(
        assignmentId,
        files.file,
        'journey-job-start',
      )
      expect(job.status).toBe('held')
      const jobPath = `jobs/${job.id}`
      const view = async (name: 'eligibility' | 'plate') =>
        dispatchView.parse(
          await client.request(`${jobPath}/${name}?printerId=${assignmentId}`),
        )
      const acknowledge = (attempt: string, idempotencyKey: string) =>
        client.request<{ id: string; action: string }>(`${jobPath}/actions`, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({
            action: 'confirm_collection',
            args: { attempt },
          }),
        })

      const initial = await view('eligibility')
      expect(initial).toMatchObject({
        jobId: job.id,
        printerId: assignmentId,
        eligible: false,
        reasons: ['plate-state-uncertain'],
        plate: { state: 'unknown' },
      })
      expect(initial.plate.attemptId).toBeDefined()
      const clearance = await acknowledge(
        initial.plate.attemptId!,
        'journey-initial-clearance',
      )
      await expect
        .poll(async () => (await client.getAction(clearance.id)).status, {
          timeout: 60_000,
        })
        .toBe('completed')
      expect(await view('eligibility')).toMatchObject({
        eligible: true,
        reasons: [],
        plate: { state: 'operator-confirmed' },
      })
      await pagePost(ownerPage, `${ownerPath}/approvals/${job.id}/decision`, {
        decision: 'approve',
      })
      await expect
        .poll(async () => (await client.getJob(job.id)).status, {
          timeout: 60_000,
        })
        .toBe('started')
      await expect.poll(() => printer.model().state).toBe('printing')

      journey.setTelemetryUpload(true)
      journey.controls.finishPrint()
      await expect
        .poll(async () => (await client.getJob(job.id)).status, {
          timeout: 90_000,
        })
        .toBe('completed')
      const plate = await view('plate')
      expect(plate.plate.state).toBe('awaiting-collection')
      expect(plate.plate.attemptId).toBeDefined()
      const action = await acknowledge(
        plate.plate.attemptId!,
        'journey-finished-clearance',
      )
      expect(action.action).toBe('confirm_collection')
      await expect
        .poll(async () => (await client.getAction(action.id)).status, {
          timeout: 60_000,
        })
        .toBe('completed')
      const replay = await acknowledge(
        plate.plate.attemptId!,
        'journey-finished-clearance',
      )
      expect(replay.id).toBe(action.id)
      expect((await view('plate')).plate.state).toBe('operator-confirmed')
      expect(printer.calls()['printer.print.start']).toBe(1)

      await expect
        .poll(
          async () =>
            (
              await client.request<{ data: unknown[] }>(
                `jobs?printerId=${assignmentId}`,
              )
            ).data,
          { timeout: 60_000 },
        )
        .toContainEqual(
          expect.objectContaining({
            jobId: job.id,
            printerId: assignmentId,
            outcome: 'completed',
          }),
        )
    } finally {
      try {
        await Promise.all([files?.close(), http?.dispose(), journey?.close()])
      } finally {
        for (const key of envKeys) {
          if (saved[key] === undefined) delete process.env[key]
          else process.env[key] = saved[key]
        }
      }
    }
  })
