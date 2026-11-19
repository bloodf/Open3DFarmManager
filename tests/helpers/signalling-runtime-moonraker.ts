import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import type { PairingPollResponse } from '../../packages/farm-protocol/src/pairing.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/index.ts'
import {
  cameraFixtureFromEnv,
  cameraRuntimeSection,
} from './signalling-snapshot-camera-fixture.ts'
import {
  assertPackagedBytes,
  assertPackagedListing,
} from './packaged-connector-bounds.ts'

export { startMoonrakerMock }

/** Explicit finite loopback fixture. Importing does not allocate resources. */
export async function createRuntimeMoonrakerFixture() {
  if (
    process.env.SIGNALLING_HTTPS_RTC_RUNTIME !== 'yes' ||
    process.env.WS_NO_BUFFER_UTIL !== '1' ||
    process.env.WS_NO_UTF_8_VALIDATE !== '1'
  )
    throw Error('Explicit runtime fixture required')
  const directory = await mkdtemp(join(tmpdir(), 'open3dfarm-rtc-runtime-'))
  const data = join(directory, 'data')
  const identity = loadOrCreateIdentity(data)
  const controller = new AbortController()
  let running: Promise<void> | undefined,
    failure = false,
    settled = false
  let simRequests = 0,
    queued = 0
  let mockInstance: MoonrakerMockInstance | undefined
  // Farm-page pause row: pause control is configured and a second socket allowed.
  const farmPause = process.env.SIGNALLING_HTTPS_FARM_PAUSE === 'yes'
  const pauseKey = process.env.SIGNALLING_HTTPS_PAUSE_PUBLIC_KEY
  if (farmPause && !pauseKey) throw Error('Farm pause issuer key required')
  // The Connector's pause inbox is admitted and waiting for a browser.
  let pauseInboxReady = false
  // How many times that inbox started listening (one per control session).
  let pauseInboxes = 0
  // Telemetry delivery attempts reported by the Connector.
  let telemetryDelivered = 0,
    telemetryRetained = 0
  let closeServer: (() => Promise<void>) | undefined
  let port = 0
  let listening = 0,
    admitted = 0,
    terminalReason: string | null = null
  let broadcast = () => {}
  let disposal: Promise<void> | undefined
  let stopPackaged: (() => Promise<void>) | undefined
  let packagedPid = 0,
    packagedSha256: string | null = null
  let packagedManifestSha256: string | null = null,
    packagedFiles = 0
  // Bounded tail of Connector diagnostic kinds, for failure reports.
  let recent: readonly string[] = []
  function diagnostic(value: unknown) {
    const parsed = z
      .object({
        kind: z.string().max(64),
        reason: z.string().max(80).optional(),
        status: z.string().max(32).optional(),
        count: z.number().optional(),
      })
      .parse(value)
    if (parsed.kind === 'delivery') {
      if (parsed.status === 'delivered') telemetryDelivered += parsed.count ?? 0
      else telemetryRetained++
    }
    if (parsed.kind !== 'queued')
      recent = [
        ...recent,
        parsed.reason ? `${parsed.kind}:${parsed.reason}` : parsed.kind,
      ].slice(-24)
    if (parsed.kind === 'queued') queued++
    if (parsed.kind === 'readonly-admitted') admitted++
    if (parsed.kind === 'readonly-listening') listening++
    if (parsed.kind === 'pause-listening') {
      pauseInboxReady = true
      pauseInboxes++
    }
    if (parsed.kind === 'pause-terminal') pauseInboxReady = false
    if (parsed.kind === 'readonly-terminal')
      terminalReason = parsed.reason ?? 'unclassified'
  }
  return {
    identity,
    /** Identity directory, for a configuration-mode run of the same agent. */
    dataDirectory: data,
    async start(input: {
      origin: string
      audience: string
      claim: Extract<PairingPollResponse, { status: 'approved' }>
      assignmentRefs: readonly {
        assignmentId: string
        agentId: string
        printerKey: string
      }[]
      /**
       * Journey harness only: another vendor's collection and assignment
       * replace the Moonraker ones (the packaged Connector is unchanged).
       */
      runtime?: {
        version: 1 | 2 | 3 | 4 | 5
        collection: Record<string, unknown>
        assignment?: Record<string, unknown>
        assignments?: readonly Record<string, unknown>[]
        /** Pause between telemetry drains of an empty queue (100..5000). */
        telemetryIdleMs?: number
        /** Opt-in camera section of the runtime file (vendor MJPEG sources). */
        camera?: (assignmentId: string) => Record<string, unknown>
      }
    }) {
      if (
        running ||
        disposal ||
        input.assignmentRefs.length < 1 ||
        (input.assignmentRefs.length !== 1 && !input.runtime?.assignments)
      )
        throw Error('Runtime fixture scope')
      const ref = input.assignmentRefs[0]!
      if (
        input.assignmentRefs.some(
          (item) => item.agentId !== input.claim.agent_id,
        )
      )
        throw Error('Runtime fixture agent')
      const moonraker = input.runtime?.assignments
        ? undefined
        : await startMoonrakerMock({
            initial: {
              state: 'printing',
              progress: 0.25,
              extruder: 210,
              bed: 60,
            },
            objects: [
              'webhooks',
              'print_stats',
              'virtual_sdcard',
              'extruder',
              'heater_bed',
            ],
            maxWsConnections: farmPause ? 2 : 1,
            maxRpcRequests: 64,
            onClientError: () => {
              failure = true
            },
          })
      if (moonraker) {
        mockInstance = moonraker
        port = moonraker.ports.http
        closeServer = () => moonraker.close()
        broadcast = () => {
          // Bounded synthetic sequence: initial, after first advance, after recovery.
          const next = ({ 0.25: 0.75, 0.75: 0.9 } as Record<number, number>)[
            moonraker.control.model().progress
          ]
          if (next === undefined) throw Error('Fixture transitions exhausted')
          moonraker.control.update({ progress: next })
        }
      }
      // Opt-in genuine simulator sources (rtc-farm-acceptance-sim-scenarios.ts).
      const sim = input.runtime?.assignments
        ? undefined
        : await (
            await import('./rtc-farm-acceptance-sim-scenarios.ts')
          ).readSimulatorSources(process.env)
      // The ready check above is the simulator's first request; the runtime
      // readiness wait expects requests > 0, which the synthetic server would
      // otherwise provide.
      if (sim) simRequests++
      const moon = sim?.moonraker ?? moonraker?.origin ?? ''
      const camera = cameraFixtureFromEnv()
      const configPath = join(directory, 'runtime.json'),
        credentialPath = join(directory, 'credential.json')
      await writeFile(
        configPath,
        JSON.stringify({
          version: input.runtime?.version ?? 1,
          collection: input.runtime?.collection ?? {
            version: 1,
            allowedOrigins: [moon],
            printers: [{ printerKey: ref.printerKey, origin: moon }],
            limits: { staleAfterMs: 5000 },
            ...(sim && {
              spoolman: {
                origin: sim.spoolman,
                farmId: input.claim.farm_id,
                serviceId: randomUUID(),
              },
            }),
          },
          assignments: input.runtime?.assignments
            ? [...input.runtime.assignments]
            : [
                input.runtime?.assignment ?? {
                  assignment_id: ref.assignmentId,
                  agent_id: ref.agentId,
                  farm_id: input.claim.farm_id,
                  printer_key: ref.printerKey,
                  moonraker_origin: moon,
                },
              ],
          ...(camera
            ? { camera: cameraRuntimeSection(camera, ref.assignmentId) }
            : {}),
          ...(input.runtime?.camera
            ? { camera: input.runtime.camera(ref.assignmentId) }
            : {}),
          telemetry: {
            endpoint: input.origin + '/api/connector/telemetry',
            audience: input.audience,
            retryMinMs: 1000,
            retryMaxMs: 1000,
            ...(input.runtime?.telemetryIdleMs === undefined
              ? {}
              : { idleMs: input.runtime.telemetryIdleMs }),
          },
          signalling: {
            endpoint:
              input.origin.replace('https:', 'wss:') +
              '/api/signalling/connector',
            origin: input.origin,
            audience: input.audience,
            retryMinMs: 1000,
            retryMaxMs: 1000,
          },
          ...(farmPause
            ? {
                pause: {
                  version: 1,
                  issuers: [
                    {
                      issuer: input.origin,
                      kid: 'pause-fixture',
                      publicKeySpki: pauseKey,
                    },
                  ],
                  signalling: {
                    endpoint:
                      input.origin.replace('https:', 'wss:') +
                      '/api/signalling/pause-connector',
                    origin: input.origin,
                    audience: 'open3dfarmmanager:pause',
                    credentialAudience: input.audience,
                  },
                  control: {
                    assignmentId: ref.assignmentId,
                    // The admin's per-printer console switch (off unless named).
                    ...(process.env.SIGNALLING_HTTPS_CONSOLE === 'yes'
                      ? { consoleAssignmentIds: [ref.assignmentId] }
                      : {}),
                  },
                },
              }
            : {}),
        }),
        { mode: 0o600, flag: 'wx' },
      )
      await writeFile(
        credentialPath,
        JSON.stringify({
          version: 1,
          expected_fingerprint: identity.fingerprint,
          approval: input.claim,
        }),
        { mode: 0o600, flag: 'wx' },
      )
      if (process.env.SIGNALLING_HTTPS_RTC_PACKAGED === 'yes') {
        const entry = new URL(
          '../../packages/connector/dist/cli.js',
          import.meta.url,
        )
        const dist = new URL('.', entry)
        const files = (await readdir(dist, { withFileTypes: true })).sort(
          (a, b) => a.name.localeCompare(b.name, 'en'),
        )
        assertPackagedListing(files)
        let totalBytes = 0
        const manifest = []
        for (const file of files) {
          const bytes = await readFile(new URL(file.name, dist))
          totalBytes += bytes.length
          assertPackagedBytes(bytes.length, totalBytes)
          manifest.push({
            name: file.name,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          })
        }
        packagedFiles = manifest.length
        packagedManifestSha256 = createHash('sha256')
          .update(JSON.stringify(manifest))
          .digest('hex')
        packagedSha256 = createHash('sha256')
          .update(await readFile(entry))
          .digest('hex')
        const child = spawn(
          process.execPath,
          [
            entry.pathname,
            'run',
            '--config',
            configPath,
            '--credential-file',
            credentialPath,
            '--data-dir',
            data,
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              NODE_OPTIONS: process.env.OPENFARM_NETWORK_GUARD_PRELOAD ?? '',
            },
          },
        )
        packagedPid = child.pid ?? 0
        let bytes = 0,
          errors = 0,
          buffer = ''
        let stderrTail = ''
        const closed = new Promise<void>((resolve) => {
          child.once('error', () => {
            failure = true
          })
          child.once('close', (code, signal) => {
            if (code !== 0 || signal !== null || buffer.length) failure = true
            // Why the packaged Connector did not stop cleanly.
            if (code !== 0 || signal !== null || buffer.length)
              console.error(
                'Packaged Connector exit',
                JSON.stringify({ code, signal, pending: buffer.length }),
                stderrTail,
              )
            console.error('Packaged Connector stderr bytes', errors, bytes)
            settled = true
            resolve()
          })
        })
        child.stdout.on('data', (chunk: Buffer) => {
          try {
            bytes += chunk.length
            if (
              bytes > 262144 ||
              Buffer.byteLength(buffer) + chunk.length > 16384
            )
              throw Error('Packaged output bound')
            buffer += new TextDecoder('utf-8', { fatal: true }).decode(chunk)
            let end: number
            while ((end = buffer.indexOf('\n')) >= 0) {
              diagnostic(
                parseBoundedJson(buffer.slice(0, end), {
                  maxBytes: 16384,
                  maxDepth: 4,
                  maxValues: 64,
                  maxStringChars: 256,
                }),
              )
              buffer = buffer.slice(end + 1)
            }
          } catch {
            failure = true
            child.kill('SIGTERM')
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          errors += chunk.length
          stderrTail = (stderrTail + chunk.toString()).slice(-1500)
          if (errors > 16384) {
            failure = true
            child.kill('SIGTERM')
          }
        })
        stopPackaged = async () => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGTERM')
          // A busy host needs longer than the strict bound below to wind down;
          // wait for it here so only a Connector that never stops fails.
          await Promise.race([
            closed,
            new Promise<void>((resolve) => setTimeout(resolve, 14_000).unref()),
          ])
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              closed,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(Error('Packaged shutdown timeout')),
                  6000,
                )
              }),
            ])
          } catch (error) {
            failure = true
            child.kill('SIGKILL')
            await closed
            throw error
          } finally {
            clearTimeout(timer)
          }
        }
        running = closed
        return
      }
      const { runConnectorAgent } =
        await import('../../packages/connector/src/runtime/agent.ts')
      running = runConnectorAgent({
        configPath,
        credentialPath,
        dataDirectory: data,
        signal: controller.signal,
        onDiagnostic: diagnostic,
      })
        .catch(() => {
          failure = true
        })
        .finally(() => {
          settled = true
        })
    },
    advance() {
      broadcast()
    },
    observe() {
      return {
        kind: 'runtime-observation' as const,
        requests: (mockInstance?.calls.all.length ?? 0) + simRequests,
        queued,
        failure,
        settled,
        directory,
        port,
        admitted,
        listening,
        terminalReason,
        packagedPid,
        packagedSha256,
        packagedManifestSha256,
        packagedFiles,
        pauses: mockInstance?.calls()['printer.print.pause'] ?? 0,
        pauseInboxReady,
        pauseInboxes,
        telemetryDelivered,
        telemetryRetained,
        recent,
      }
    },
    close() {
      disposal ??= (async () => {
        controller.abort()
        const errors: unknown[] = []
        try {
          await stopPackaged?.()
        } catch (error) {
          errors.push(error)
        }
        try {
          await running
        } catch (error) {
          errors.push(error)
        }
        try {
          await closeServer?.()
        } catch (error) {
          errors.push(error)
        }
        if (errors.length || failure)
          throw Error('Runtime fixture cleanup/failure')
        await rm(directory, { recursive: true })
      })()
      return disposal
    },
  }
}
