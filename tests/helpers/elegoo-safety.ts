import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import type {
  ControlObservation,
  PreparedPauseDriver,
} from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  provisionSdcpPrinter,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import {
  createApiCommandRunner,
  type QualifiedResinDispatch,
} from '../../packages/connector/src/runtime/api-command.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { openFixedSdcpControl } from '../../packages/connector/src/sdcp/control-driver.ts'
import { type SdcpQualification } from '../../packages/connector/src/sdcp/models.ts'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

export const CARBON = 'Centauri Carbon'
export const RESIN = 'Saturn 4 Ultra'
export const FIRMWARE = 'V1.0.0'
export const QUALIFIED: SdcpQualification[] = [CARBON, RESIN].map((model) => ({
  model,
  firmwareVersion: FIRMWARE,
}))
export const LIFECYCLE = ['pause', 'resume', 'cancel']

type Scope = {
  assignment_id: string
  farm_id: string
  agent_id: string
  printer_key: string
}

export async function printer(
  t: TestContext,
  model: string,
  scope: Scope = {
    assignment_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    printer_key: 'elegoo',
  },
) {
  const sim = await startSdcpSimulator({
    Id: 'fixture',
    Data: {
      Name: 'Test',
      MachineName: model,
      MainboardIP: '127.0.0.1',
      MainboardID: 'board01',
      ProtocolVersion: 'V3.0.0',
      FirmwareVersion: FIRMWARE,
    },
  })
  let closed: Promise<void> | undefined
  const close = () => (closed ??= sim.close())
  t.after(close)
  const machine = sim.simulate({ family: model === CARBON ? 'fdm' : 'resin' })
  for (const file of ['part.gcode', 'part.ctb', 'part.goo'])
    machine.files.set(file, Buffer.from('synthetic'))
  const binding = provisionSdcpPrinter(scope, {
    printerKey: scope.printer_key,
    host: '127.0.0.1',
    mainboardId: 'board01',
    model,
    discoveryPort: sim.discoveryPort,
    websocketPort: sim.websocketPort,
    uploadPort: sim.websocketPort,
  })
  /** Command frames received; the status poll is Cmd 0. */
  const sent = () =>
    sim.requests
      .map((request) => (request as { Data: { Cmd: number } }).Data.Cmd)
      .filter((cmd) => cmd !== 0)
  /** The printer turns busy between the dispatcher's check and the send. */
  async function turnBusy() {
    machine.transferring = true
    sim.report()
    await sleep(60)
  }
  return { sim, machine, binding, sent, turnBusy, close }
}

export const router = (
  qualified: SdcpQualification[] | undefined,
  observe: (
    binding: PrinterBinding,
    observation: ControlObservation | null,
  ) => boolean = () => true,
  clock = { monotonicNow: () => performance.now() },
) =>
  createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock,
    observe,
    ...(qualified ? { sdcpQualifiedStarts: qualified } : {}),
  })

/**
 * The shipped browser dispatcher over a signed command. `busy` swaps in a
 * driver with a short idle wait: the router's own equals the result window.
 */
export async function browser(
  t: TestContext,
  model: string,
  qualified: SdcpQualification[] | undefined,
  busy = false,
) {
  const authority = await createV2Authority(await nodeSigner())
  const target = await printer(t, model, {
    assignment_id: authority.ids.assignment_id,
    farm_id: authority.ids.farm_id,
    agent_id: authority.ids.agent_id,
    printer_key: authority.printerKey,
  })
  let outer: PrinterBinding
  let retired: Promise<void> | undefined
  const session = await openV2Dispatch(authority, {
    capability: { role: 'owner', actions: ['pause', 'start_print'] },
    loopback: {
      origin: 'http://127.0.0.1:7125',
      driver({ clock, observe }) {
        const forward = (
          _inner: PrinterBinding,
          observation: ControlObservation | null,
        ) => observe(outer, observation)
        const routes = router(qualified, forward, clock)
        const inner = target.binding
        let short: ReturnType<typeof openFixedSdcpControl> | undefined
        const driver: PreparedPauseDriver & {
          detect(binding: PrinterBinding): Promise<unknown>
        } = {
          detect: () => routes.detect(inner),
          controls: () => routes.controls(inner),
          async prepare(input) {
            outer = input.binding
            retired = undefined
            if (!busy)
              return routes.prepare({ binding: inner, signal: input.signal })
            short = openFixedSdcpControl({
              binding: inner,
              connectionGeneration: 1,
              clock,
              publish: (observation) => forward(inner, observation),
              signal: input.signal,
              timeoutMs: 200,
              pollMs: 20,
              qualifiedStarts: qualified,
            })
            await short.prepare()
            return { connectionGeneration: 1 }
          },
          async execute(action, args, input) {
            if (!short)
              return routes.execute(action, args, { ...input, binding: inner })
            await target.turnBusy()
            return short.driver.execute!(action, args, {
              ...input,
              binding: inner,
            })
          },
          pauseOnce: (input) => routes.pauseOnce({ ...input, binding: inner }),
          waitForPaused: (input) =>
            routes.waitForPaused({ ...input, binding: inner }),
          closeAttempt() {
            retired = short ? short.close() : routes.closeAttempt(inner)
            return retired
          },
        }
        return driver
      },
    },
  })
  t.after(() => session.close())
  async function run(
    action: ExtendedControlAction,
    args: Record<string, unknown> = {},
  ) {
    const result = await session.dispatch(
      await authority.sign(
        {
          action,
          args,
          purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        },
        session.now(),
      ),
    )
    await retired
    return result
  }
  async function refused(
    kind: 'rejected' | 'not-sent',
    file: string,
    reason: string,
  ) {
    const result = await run('start_print', { file })
    assert.equal(result.kind, kind, JSON.stringify(result))
    assert.equal('reason' in result && result.reason, reason)
  }
  /** A refusal leaves no lock: the next command reaches the printer. */
  async function pauses() {
    target.machine.transferring = false
    target.machine.phase = 'printing'
    const result = await run('pause')
    assert.equal(result.kind, 'applied', JSON.stringify(result))
    assert.deepEqual(target.sent(), [129])
  }
  return { ...target, run, refused, pauses, journal: session.journal }
}

const tls = (name: string) =>
  readFileSync(new URL(`../fixtures/bambu-ftps/${name}.pem`, import.meta.url))

/** The shipped API command runner, with the shipped SDCP router and upload. */
export async function api(
  t: TestContext,
  model: string,
  qualified: SdcpQualification[] | undefined,
) {
  const ids = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const target = await printer(t, model, { ...ids, printer_key: 'elegoo' })
  const file = Buffer.from('synthetic job')
  const sha256 = createHash('sha256').update(file).digest('hex')
  let downloads = 0
  const source = createServer(
    { cert: tls('cert'), key: tls('key') },
    (_request, reply) => {
      downloads++
      reply.end(file)
    },
  )
  source.listen(0, '127.0.0.1')
  await once(source, 'listening')
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const directory = mkdtempSync(join(tmpdir(), 'rv-elegoo-'))
  const journal = openCommandJournal({ directory, clock: Date.now })
  t.after(() => {
    source.closeAllConnections()
    source.close()
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  const app = randomUUID(),
    grant = randomUUID()
  const routes = router(qualified)
  await routes.detect(target.binding)
  const authority = createOfflineAuthority()
  authority.confirm({ wall: Date.now(), mono: performance.now() }, 1)
  /** The name the library start hands the driver. */
  let libraryFile = ''
  /** Runs on the way into the driver, after every runner check. */
  let beforeExecute = async () => {}
  const reports: ReturnType<typeof decodeApiEnvelopeResultFrame>[] = []
  let validated = 0
  const resinCapability: QualifiedResinDispatch = {
    assignmentId: ids.assignment_id,
    profile: 'elegoo:saturn-4-ultra',
    extensions: ['.ctb', '.goo'],
    async validate({ path }) {
      assert.equal(path, 'synthetic-verified-artifact')
      validated++
      return { ok: true }
    },
    async dispatch({ startVerifiedSdcp }) {
      assert.ok(startVerifiedSdcp)
      return startVerifiedSdcp()
    },
  }
  const runner = createApiCommandRunner({
    farmId: ids.farm_id,
    agentId: ids.agent_id,
    keys: { issuer: () => issuer.publicKey },
    grants: {
      lookup: () => ({
        grant_id: grant,
        app_id: app,
        farm_id: ids.farm_id,
        scopes: ['jobs:start', 'jobs:write'],
        revoked: false,
      }),
      freshness: authority.freshness,
    },
    journal,
    printer: () => target.binding,
    observe: () => ({ ready: true, printState: 'idle' }),
    driver: {
      ...routes,
      async execute(action, args, input) {
        await beforeExecute()
        return routes.execute(action, args, input)
      },
    },
    jobFiles: {
      directory: join(directory, 'jobs'),
      targetFor: () => ({ backend: 'sdcp', binding: target.binding }),
      ca: tls('cert'),
    },
    libraryPrint: {
      async withVerifiedArtifact(_hash, _signal, use) {
        await use('synthetic-verified-artifact')
        return { ok: true }
      },
      async start({ start }) {
        await start(libraryFile, {})
        return { ok: true } as never
      },
    },
    resinCapabilities: () => [resinCapability],
    report: (wire) => reports.push(decodeApiEnvelopeResultFrame(wire)),
    clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
  })
  async function send(body: {
    kind: 'job' | 'library' | 'resin'
    name: string
  }) {
    const cmdId = randomUUID()
    const issuedAt = Date.now()
    if (body.kind === 'library') libraryFile = body.name
    const result = await runner.run(
      encodeApiEnvelopeFrame({
        v: 1,
        t: 'api-envelope.command',
        envelope: await signApiEnvelope(
          {
            v: 1,
            purpose: 'api-envelope',
            issuer: API_ENVELOPE_ISSUER,
            kid: 'test',
            app_id: app,
            grant_id: grant,
            ...ids,
            resource_id: randomUUID(),
            cmd_id: cmdId,
            nonce: newApiEnvelopeNonce(),
            issued_at: issuedAt,
            expires_at: issuedAt + 60000,
            ...(body.kind === 'job'
              ? {
                  kind: 'job',
                  job: {
                    file_url: `https://localhost:${(source.address() as AddressInfo).port}/file`,
                    sha256,
                    size_bytes: file.length,
                    display_name: body.name,
                  },
                }
              : {
                  kind: 'action',
                  action: {
                    action: 'start_library_print',
                    args:
                      body.kind === 'resin'
                        ? {
                            sha256,
                            versionId: randomUUID(),
                            profile: 'elegoo:saturn-4-ultra',
                            filename: body.name,
                            plate: 1,
                          }
                        : { sha256 },
                  },
                }),
          },
          issuer.privateKey,
        ),
      }),
    )
    return { result, status: readCommandOutcome(journal, cmdId)?.status }
  }
  async function refused(
    body: Parameters<typeof send>[0],
    code: string,
    detail: string,
  ) {
    const { result, status } = await send(body)
    assert.deepEqual(result, { kind: 'refused', code, detail })
    assert.equal(status, 'not-sent')
    assert.deepEqual(target.sent(), [])
  }
  return {
    ...target,
    send,
    refused,
    downloads: () => downloads,
    validated: () => validated,
    reports,
    onExecute(hook: () => Promise<void>) {
      beforeExecute = hook
    },
  }
}
