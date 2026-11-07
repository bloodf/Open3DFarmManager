import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { browserBundle } from './browser-bundle.ts'
import type { JSHandle } from '@playwright/test'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import type {
  FixtureIdentityHandles,
  ProvisionedSignallingFixture,
  SignallingFixtureExtension,
  SignallingIdentityInput,
} from './signalling-https-fixture-contract.ts'
import type { createPauseExecutionRtcBrowserActor } from './pause-execution-rtc-browser.ts'
import {
  PAUSE_EXECUTION_RTC_IPC_BYTES,
  PauseExecutionRtcCommand,
  PauseExecutionRtcReply,
  PauseExecutionRtcIssuer,
} from './pause-execution-rtc-connector-child.ts'
import { waitFixtureClose } from './signalling-https-process.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { snapshotAssignmentRefs } from '../../packages/connector/src/webrtc/readonly-session.ts'

type BrowserActor = Awaited<
  ReturnType<typeof createPauseExecutionRtcBrowserActor>
>

export const PauseExecutionBrowserObservation = z.strictObject({
  terminal: z.boolean(),
  failed: z.boolean(),
  proofsReady: z.boolean(),
  admitted: z.boolean(),
  commandSent: z.boolean(),
  commandHttpRequests: z.number().int().nonnegative(),
  outcome: z.enum(['applied', 'rejected', 'outcome-unknown']).nullable(),
  commandReceipt: z
    .strictObject({
      commandId: z.string().uuid(),
      transportId: z.string().uuid(),
      outcome: z.enum(['applied', 'rejected', 'outcome-unknown']),
    })
    .nullable(),
  diagnostics: z
    .strictObject({
      certificateMatched: z.boolean(),
      sentProofs: z.number().int().min(0).max(1),
      receivedProofs: z.number().int().min(0).max(1),
      terminal: z.boolean(),
      commandsEnabled: z.boolean(),
    })
    .optional(),
})

export type PauseExecutionBrowserObservation = z.infer<
  typeof PauseExecutionBrowserObservation
>

export const PauseExecutionNativeObservation = z.strictObject({
  kind: z.literal('observation'),
  inboxReady: z.boolean(),
  proofsReady: z.boolean(),
  capabilityAccepted: z.boolean(),
  commandReceived: z.boolean(),
  commandsReceived: z.number().int().nonnegative(),
  pausesObserved: z.number().int().nonnegative(),
  latestPrintState: z.string().nullable(),
  commandId: z.string().uuid().nullable(),
  transportId: z.string().uuid().nullable(),
  commandOutcome: z
    .enum(['applied', 'rejected', 'outcome-unknown', 'not-sent'])
    .nullable(),
  terminal: z.boolean(),
  failed: z.boolean(),
  diagnostics: z.strictObject({
    certificateMatched: z.boolean(),
    sentProofs: z.number().int().min(0).max(1),
    receivedProofs: z.number().int().min(0).max(1),
    terminal: z.boolean(),
    commandsEnabled: z.literal(true),
  }),
  relayDiagnostics: z
    .strictObject({
      peers: z.number().int().nonnegative(),
      admitted: z.number().int().nonnegative(),
      commands: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      notSent: z.number().int().nonnegative(),
      applied: z.number().int().nonnegative(),
      outcomeUnknown: z.number().int().nonnegative(),
      unsentResults: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      closed: z.boolean(),
      lastReason: z.string().optional(),
    })
    .nullable(),
  progress: PauseExecutionRtcReply.options[6].shape.progress,
})

export type PauseExecutionNativeObservation = z.infer<
  typeof PauseExecutionNativeObservation
>

/**
 * Execution acceptance requires matching command/transport IDs, exactly one
 * simulator-observed printer.print.pause, a fresh paused observation, and browser
 * receipt outcome applied for that command.
 *
 * Native capabilityAccepted alone MUST fail execution acceptance.
 */
export function verifyPauseExecutionAcceptance(
  nativeValue: unknown,
  browserValue: unknown,
  options: {
    expectedCommandId?: string
    expectedTransportId?: string
  } = {},
) {
  const native = PauseExecutionNativeObservation.parse(nativeValue)
  const browser = PauseExecutionBrowserObservation.parse(browserValue)

  // Transport and admission assertions
  assert.equal(native.inboxReady, true, 'Native inbox must be ready')
  assert.equal(native.proofsReady, true, 'Native proofs must be ready')
  assert.equal(native.capabilityAccepted, true, 'Native capability must be accepted')
  assert.equal(browser.proofsReady, true, 'Browser proofs must be ready')
  assert.equal(browser.admitted, true, 'Browser client must be admitted')
  assert.equal(browser.commandSent, true, 'Browser command must be sent')

  // Execution assertions: capabilityAccepted alone must fail execution acceptance
  assert.equal(
    native.commandReceived,
    true,
    'Native actor must observe command receipt',
  )
  assert.equal(
    native.pausesObserved,
    1,
    'Simulator must observe exactly one printer.print.pause',
  )
  assert.equal(
    native.latestPrintState,
    'paused',
    'Simulator must observe fresh paused state',
  )
  assert.equal(
    browser.outcome,
    'applied',
    'Browser outcome must be applied',
  )
  assert.ok(
    browser.commandReceipt,
    'Browser receipt must be present',
  )
  assert.equal(
    browser.commandReceipt.outcome,
    'applied',
    'Browser receipt outcome must be applied',
  )

  // Correlated identifiers
  assert.ok(native.commandId, 'Native commandId must be non-null')
  assert.ok(native.transportId, 'Native transportId must be non-null')
  assert.equal(
    native.commandId,
    browser.commandReceipt.commandId,
    'Native and browser command IDs must match',
  )
  assert.equal(
    native.transportId,
    browser.commandReceipt.transportId,
    'Native and browser transport IDs must match',
  )

  if (options.expectedCommandId) {
    assert.equal(
      native.commandId,
      options.expectedCommandId,
      'Command ID must match expected',
    )
  }
  if (options.expectedTransportId) {
    assert.equal(
      native.transportId,
      options.expectedTransportId,
      'Transport ID must match expected',
    )
  }

  // Diagnostic checks
  assert.equal(native.terminal, false, 'Native actor must not be terminal')
  assert.equal(native.failed, false, 'Native actor must not be failed')
  assert.equal(browser.terminal, false, 'Browser actor must not be terminal')
  assert.equal(browser.failed, false, 'Browser actor must not be failed')
  assert.equal(
    native.diagnostics.certificateMatched,
    true,
    'Control certificate must match',
  )
  assert.equal(native.diagnostics.sentProofs, 1, 'Sent proofs must be 1')
  assert.equal(native.diagnostics.receivedProofs, 1, 'Received proofs must be 1')
  assert.equal(
    native.diagnostics.commandsEnabled,
    true,
    'Native actor diagnostics must report commandsEnabled: true',
  )
}

/** Negative row: authority revocation before send results in terminal teardown and zero pauses. */
export function verifyPauseExecutionRevocation(
  nativeValue: unknown,
  browserValue: unknown,
) {
  const native = PauseExecutionNativeObservation.parse(nativeValue)
  const browser = PauseExecutionBrowserObservation.parse(browserValue)

  assert.equal(
    native.pausesObserved,
    0,
    'Zero pause calls must reach simulator after authority mutation',
  )
  assert.ok(
    native.terminal && browser.terminal,
    'Terminal teardown must be observed on revoked authority',
  )
  assert.notEqual(
    browser.outcome,
    'applied',
    'Revocation must prevent applied outcome',
  )
}

/** Negative row: disconnect results in read-only degradation with zero simulator commands. */
export function verifyPauseExecutionDegradation(
  nativeValue: unknown,
  browserValue: unknown,
  httpCounts?: { commands: number },
) {
  const native = PauseExecutionNativeObservation.parse(nativeValue)
  const browser = PauseExecutionBrowserObservation.parse(browserValue)

  assert.equal(
    native.pausesObserved,
    0,
    'Zero simulator commands during degraded disconnect',
  )
  assert.equal(
    httpCounts?.commands ?? browser.commandHttpRequests,
    0,
    'Command bytes must travel exclusively via RTC, zero command HTTP requests',
  )
  assert.ok(
    native.terminal && browser.terminal,
    'Degraded teardown must be observed on disconnect',
  )
  assert.notEqual(
    browser.outcome,
    'applied',
    'Disconnect must prevent applied outcome',
  )
}

async function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  ms: number,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {})
    throw Error('RTC fixture aborted')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(Error('RTC fixture aborted'))
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => reject(Error('RTC fixture deadline')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  signal: AbortSignal,
  ms: number,
) {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    const value = await bounded(
      read(),
      signal,
      Math.max(1, deadline - performance.now()),
    )
    if (accept(value)) return value
    await bounded(
      new Promise<void>((resolve) => setTimeout(resolve, 200)),
      signal,
      250,
    )
  }
  throw Error('RTC fixture observation deadline')
}

async function resourceLedger(input: SignallingIdentityInput) {
  const parentLedger = process.env.SIGNALLING_HTTPS_LEDGER
  const path =
    process.env.PAUSE_EXECUTION_RTC_LEDGER ??
    (parentLedger ? parentLedger + '.pause-execution-rtc-resources.jsonl' : undefined)
  const checkout = await realpath(new URL('../..', import.meta.url))
  if (!path || !isAbsolute(path))
    throw Error('Private execution RTC resource ledger required')
  const { dirname, basename, join } = await import('node:path')
  const ledger = join(await realpath(dirname(path)), basename(path))
  const ca = await realpath(input.caPath)
  for (const candidate of [ledger, ca]) {
    const r = relative(checkout, candidate)
    if (!r.startsWith('../') && !isAbsolute(r))
      throw Error('Fixture files must stay outside checkout')
  }
  const created = await open(ledger, 'ax', 0o600)
  await created.close()
  return async (event: string, pid?: number) => {
    await appendFile(
      ledger,
      JSON.stringify({ event, ...(pid ? { pid } : {}) }) + '\n',
      { mode: 0o600 },
    )
  }
}

async function connectorChild(
  input: SignallingIdentityInput,
  note: Awaited<ReturnType<typeof resourceLedger>>,
) {
  const child = spawn(
    process.execPath,
    [new URL('./pause-execution-rtc-connector-child.ts', import.meta.url).pathname],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        NODE_OPTIONS: '',
        NODE_EXTRA_CA_CERTS: input.caPath,
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
        WS_NO_BUFFER_UTIL: '1',
        WS_NO_UTF_8_VALIDATE: '1',
        PAUSE_EXECUTION_RTC_CHILD: 'yes',
      },
    },
  )
  const closed = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let failure = false,
    disposing: Promise<void> | undefined,
    output = Buffer.alloc(0),
    outputBytes = 0,
    errorBytes = 0,
    requests = 0,
    requestBytes = 0
  let pending:
    | {
        resolve: (reply: PauseExecutionRtcReply) => void
        reject: (error: Error) => void
      }
    | undefined

  const fail = () => {
    failure = true
    pending?.reject(Error('RTC execution child rejected or closed'))
    pending = undefined
    output = Buffer.alloc(0)
    child.stdin.end()
  }

  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stdout.on('error', fail)
  child.stderr.on('error', fail)
  child.once('close', () => {
    if (pending) fail()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    errorBytes += chunk.byteLength
    if (errorBytes > 8192) fail()
  })
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.byteLength
    if (
      failure ||
      outputBytes > 65_536 ||
      output.byteLength + chunk.byteLength > PAUSE_EXECUTION_RTC_IPC_BYTES
    ) {
      fail()
      return
    }
    output = Buffer.concat([output, chunk])
    const end = output.indexOf(10)
    if (end < 0) return
    try {
      if (!pending || end !== output.byteLength - 1)
        throw Error('Unexpected child frame')
      const reply = PauseExecutionRtcReply.parse(
        parseBoundedJson(
          new TextDecoder('utf-8', { fatal: true }).decode(
            output.subarray(0, end),
          ),
          {
            maxBytes: PAUSE_EXECUTION_RTC_IPC_BYTES,
            maxDepth: 6,
            maxValues: 128,
            maxStringChars: 8192,
          },
        ),
      )
      if (reply.kind === 'failed') throw Error('Child failure')
      const waiter = pending
      pending = undefined
      output = Buffer.alloc(0)
      waiter.resolve(reply)
    } catch {
      fail()
    }
  })

  const request = async (command: PauseExecutionRtcCommand) => {
    if (
      failure ||
      disposing ||
      pending ||
      ++requests > 128 ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      throw Error('RTC execution child unavailable')
    const wire = JSON.stringify(PauseExecutionRtcCommand.parse(command)) + '\n'
    requestBytes += Buffer.byteLength(wire)
    if (
      Buffer.byteLength(wire) > PAUSE_EXECUTION_RTC_IPC_BYTES ||
      requestBytes > 65536
    )
      throw Error('IPC request limit')
    const reply = new Promise<PauseExecutionRtcReply>((resolve, reject) => {
      pending = { resolve, reject }
    })
    child.stdin.write(wire, (error) => {
      if (error) fail()
    })
    try {
      return await bounded(reply, input.signal, 3000)
    } catch {
      fail()
      throw Error('RTC execution child request failed')
    }
  }

  const dispose = () => {
    if (disposing) return disposing
    disposing = (async () => {
      child.stdin.end()
      let forced = false
      try {
        await waitFixtureClose(
          closed.then((receipt) => [receipt]),
          5000,
        )
      } catch {
        forced = true
        child.kill('SIGKILL')
        await waitFixtureClose(
          closed.then((receipt) => [receipt]),
          3000,
        )
      }
      const receipt = await closed
      pending?.reject(Error('RTC execution child disposed'))
      pending = undefined
      output = Buffer.alloc(0)
      await note(
        forced
          ? 'connector-child-owned-kill-close-drained'
          : 'connector-child-close-drained',
        child.pid,
      )
      if (forced || failure || receipt.code !== 0 || receipt.signal !== null)
        throw Error('RTC execution child cleanup required forced or failed exit')
    })()
    return disposing
  }

  try {
    await note('connector-child-created', child.pid)
  } catch {
    await dispose()
    throw Error('RTC resource receipt failed')
  }

  return {
    request,
    dispose,
    exitDiagnostics: () =>
      Object.freeze({
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      }),
  }
}

export type PauseExecutionFixtureOptions = Readonly<{
  closure?: 'standard' | 'revocation' | 'disconnect'
  testReplay?: boolean
}>

/**
 * Creates the execution-specific HTTPS/RTC test fixture extension.
 * Reuses maintained HTTPS provisioning, browser identity, authenticated signalling
 * and Moonraker loopback fixture with createPauseCommandRelay and actual pause execution.
 */
export function createPauseExecutionRtcFixtureExtension(
  options: PauseExecutionFixtureOptions = {},
): SignallingFixtureExtension {
  const closureMode = options.closure ?? 'standard'
  let current:
    | {
        input: SignallingIdentityInput
        handles: FixtureIdentityHandles
        actor: JSHandle<BrowserActor>
        connector: Awaited<ReturnType<typeof connectorChild>>
        issuer: z.infer<typeof PauseExecutionRtcIssuer>
        note: Awaited<ReturnType<typeof resourceLedger>>
      }
    | undefined
  let used = false

  return Object.freeze({
    async identityHandles(input: SignallingIdentityInput) {
      input.signal.throwIfAborted()
      if (used) throw Error('Pause execution RTC fixture already used')
      if (
        new URL(input.origin).origin !== input.origin ||
        new URL(input.origin).protocol !== 'https:' ||
        new URL(input.origin).hostname !== '127.0.0.1' ||
        new URL(input.ownerPage.url()).origin !== input.origin
      )
        throw Error('Authenticated HTTPS loopback page required')
      used = true
      input = Object.freeze({ ...input })
      const note = await resourceLedger(input)
      await note(
        'source-baseline-required-parent-owned; no physical printer or external resources',
      )

      const bundleText = await browserBundle(
        new URL('./pause-execution-rtc-browser.ts', import.meta.url).pathname,
        input.signal,
      )
      assert.ok(Buffer.byteLength(bundleText) <= 1024 * 1024)
      await note('pause-execution-browser-bundle-in-memory-completed')

      const route = input.origin + '/__pause_execution_rtc_fixture__.js'
      const serve: Parameters<typeof input.ownerPage.route>[1] = (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: bundleText,
        })

      let connector: Awaited<ReturnType<typeof connectorChild>> | undefined
      let actor: JSHandle<BrowserActor> | undefined
      let disposal: Promise<void> | undefined

      const dispose = () => {
        if (disposal) return disposal
        disposal = (async () => {
          input.signal.removeEventListener('abort', abort)
          const results = await Promise.allSettled([
            (async () => {
              try {
                await actor?.evaluate((actor) => actor.dispose())
              } finally {
                await actor?.dispose()
              }
            })(),
            connector?.dispose(),
            input.ownerPage.unroute(route, serve),
          ])
          current = undefined
          await note(
            'pause-execution-browser-actor-and-route-disposed; parent-owns-pages-and-context',
          )
          if (results.some((r) => r.status === 'rejected'))
            throw Error('Pause execution RTC fixture cleanup incomplete')
        })()
        return disposal
      }

      const abort = () => {
        void dispose().catch(() => {})
      }

      const issuerKey = process.env.SIGNALLING_HTTPS_PAUSE_PUBLIC_KEY
      if (!issuerKey) {
        // Fallback or explicit check for execution fixture public key
        throw Error('SIGNALLING_HTTPS_PAUSE_PUBLIC_KEY required for pause execution')
      }

      const issuer = PauseExecutionRtcIssuer.parse({
        issuer: input.origin,
        kid: 'pause-fixture',
        audience: 'open3dfarmmanager:pause',
        publicKeySpki: issuerKey,
      })

      try {
        await input.ownerPage.route(route, serve)
        input.signal.throwIfAborted()

        actor = await bounded(
          input.ownerPage.evaluateHandle(
            async ({ path, scope }) => {
              const module: typeof import('./pause-execution-rtc-browser.ts') =
                await import(path)
              return module.createPauseExecutionRtcBrowserActor(scope)
            },
            {
              path: route,
              scope: {
                accountId: input.accountId,
                farmId: input.farmId,
                origin: input.origin,
                audience: issuer.audience,
                issuer: issuer.issuer,
                kid: issuer.kid,
                publicKeySpki: issuer.publicKeySpki,
              },
            },
          ),
          input.signal,
          10000,
        )
        input.signal.throwIfAborted()
        await note('pause-execution-browser-device-key-created')

        const publicJwk = (
          await validateBrowserDevicePublicKey(
            await actor.evaluate((actor) => actor.publicJwk),
          )
        ).publicKey

        connector = await connectorChild(input, note)
        const identity = await connector.request({ kind: 'identity' })
        if (identity.kind !== 'identity')
          throw Error('Pause execution connector identity missing')

        const ownedActor = actor,
          ownedConnector = connector
        const handles: FixtureIdentityHandles = Object.freeze({
          browser: Object.freeze({
            publicJwk: Object.freeze({ ...publicJwk }),
            signEnrollment: (
              challenge: Parameters<
                FixtureIdentityHandles['browser']['signEnrollment']
              >[0],
            ) => {
              input.signal.throwIfAborted()
              return bounded(
                ownedActor.evaluate(
                  (actor, challenge) => actor.signEnrollment(challenge),
                  challenge,
                ),
                input.signal,
                2000,
              )
            },
          }),
          connector: Object.freeze({
            publicKeySpki: identity.publicKeySpki,
            fingerprint: identity.fingerprint,
            async signPairing(
              challenge: Parameters<
                FixtureIdentityHandles['connector']['signPairing']
              >[0],
              origin: string,
              audience: string,
            ) {
              if (origin !== input.origin || audience !== input.audience)
                throw Error('Pause execution pairing scope mismatch')
              const reply = await ownedConnector.request({
                kind: 'pairing',
                challenge,
                origin,
                audience,
              })
              if (reply.kind !== 'pairing')
                throw Error('Pause execution pairing proof missing')
              return reply.signature
            },
          }),
          dispose,
        })

        current = { input, handles, actor, connector, issuer, note }
        input.signal.addEventListener('abort', abort, { once: true })
        input.signal.throwIfAborted()
        return handles
      } catch {
        await dispose()
        throw Error('Pause execution RTC identity setup failed')
      }
    },

    async afterProvisioned(input: ProvisionedSignallingFixture) {
      const session = current
      if (
        !session ||
        session.handles !== input.identities ||
        session.input.ownerPage !== input.ownerPage ||
        session.input.signal !== input.signal ||
        session.input.accountId !== input.accountId ||
        session.input.farmId !== input.farmId ||
        session.input.origin !== input.origin ||
        session.input.audience !== input.audience ||
        input.claim.farm_id !== input.farmId
      )
        throw Error('Provisioned pause execution fixture scope mismatch')

      let completed = false

      try {
        input.signal.throwIfAborted()
        const refs = snapshotAssignmentRefs(
          input.assignmentRefs,
          input.claim.agent_id,
        )
        assert.equal(
          refs.length,
          1,
          'Parent must register and read back exactly one current 0015 assignment',
        )
        const assignment = refs[0]!

        const identity = await validateBrowserDevicePublicKey(
          input.identities.browser.publicJwk,
        )
        assert.equal(identity.thumbprint, input.browserThumbprint)

        const started = await session.connector.request({
          kind: 'start',
          origin: input.origin,
          credentialAudience: input.audience,
          issuer: session.issuer,
          claim: input.claim,
          accountId: input.accountId,
          browserKeyId: input.browserKeyId,
          assignment: { ...assignment },
        })
        assert.equal(started.kind, 'started')

        const observeNative = async () => {
          const value = await session.connector.request({ kind: 'observe' })
          if (value.kind !== 'observation')
            throw Error('Pause execution connector observation missing')
          return value
        }

        await until(
          observeNative,
          (value) => value.inboxReady,
          input.signal,
          7500,
        )

        await session.actor.evaluate((actor, scope) => actor.start(scope), {
          browserKeyId: input.browserKeyId,
          agentId: input.claim.agent_id,
          assignmentId: assignment.assignmentId,
        })

        const observeBrowser = async () => {
          return PauseExecutionBrowserObservation.parse(
            await session.actor.evaluate((actor) => actor.observe()),
          )
        }

        // Authority issuance starts inside pause(); proofs precede that operation.
        await Promise.all([
          until(observeNative, (v) => v.proofsReady && !v.terminal && !v.failed, input.signal, 10000),
          until(observeBrowser, (v) => v.proofsReady && !v.terminal && !v.failed, input.signal, 10000),
        ])

        if (closureMode === 'revocation') {
          // Negative row: Mutate authority during active session before command send
          await input.revokeConnector()
          await Promise.all([
            until(observeNative, (v) => v.terminal, input.signal, 8000),
            until(observeBrowser, (v) => v.terminal, input.signal, 8000),
          ])
          assert.equal(await session.actor.evaluate((actor) => actor.pause()), 'rejected')
          verifyPauseExecutionRevocation(await observeNative(), await observeBrowser())
          await session.note(
            'authenticated-pause-execution-revocation-verified; zero simulator commands',
          )
          completed = true
          return
        }

        if (closureMode === 'disconnect') {
          // Negative row: Disconnect signalling/RTC and verify read-only degradation
          await input.disconnectSignalling()
          await Promise.all([
            until(observeNative, (v) => v.terminal, input.signal, 8000),
            until(observeBrowser, (v) => v.terminal, input.signal, 8000),
          ])
          assert.equal(await session.actor.evaluate((actor) => actor.pause()), 'rejected')
          verifyPauseExecutionDegradation(await observeNative(), await observeBrowser())
          await session.note(
            'authenticated-pause-execution-disconnect-degradation-verified; zero simulator commands',
          )
          completed = true
          return
        }

        // Standard execution path: Trigger browser pause command
        const pauseOutcomePromise = session.actor.evaluate((actor) => actor.pause())

        // Wait for command delivery, execution and browser settlement
        const [nativeFinal, browserFinal] = await Promise.all([
          until(
            observeNative,
            (v) => v.pausesObserved === 1 && v.latestPrintState === 'paused' && v.commandOutcome === 'applied',
            input.signal,
            10000,
          ),
          until(
            observeBrowser,
            (v) => v.outcome === 'applied',
            input.signal,
            10000,
          ),
        ])

        const pauseOutcome = await pauseOutcomePromise
        assert.equal(pauseOutcome, 'applied')

        verifyPauseExecutionAcceptance(nativeFinal, browserFinal)

        if (options.testReplay) {
          // Verify replay produces no second simulator command
          const replayOutcome = await session.actor.evaluate((actor) => actor.replay())
          assert.equal(replayOutcome, true, 'Replay must resend the original signed wire over RTC')
          const replayNative = await until(observeNative, (v) => v.commandsReceived >= 2 && (v.relayDiagnostics?.pending ?? 1) === 0, input.signal, 5000)
          assert.equal(
            replayNative.pausesObserved,
            1,
            'Replaying must not produce a second simulator pause request',
          )
        }

        await session.note(
          'authenticated-pause-execution-correlated-pause-applied-verified; exact 1 simulator pause',
        )
        completed = true
      } finally {
        try {
          await input.identities.dispose()
        } finally {
          if (!completed)
            await session.note(
              'authenticated-pause-execution-incomplete; no acceptance claimed',
            )
        }
      }
    },
  })
}
