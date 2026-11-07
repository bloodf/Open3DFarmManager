import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { appendFile, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { promisify } from 'node:util'
import type { JSHandle } from '@playwright/test'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import type {
  FixtureIdentityHandles,
  ProvisionedSignallingFixture,
  SignallingFixtureExtension,
  SignallingIdentityInput,
} from './signalling-https-fixture-contract.ts'
import type { createPauseRtcBrowserActor } from './pause-rtc-browser.ts'
import {
  PAUSE_RTC_IPC_BYTES,
  PauseRtcCommand,
  PauseRtcReply,
  PauseRtcIssuer,
} from './pause-rtc-connector-child.ts'
import { waitFixtureClose } from './signalling-https-process.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { snapshotAssignmentRefs } from '../../packages/connector/src/webrtc/readonly-session.ts'

type BrowserActor = Awaited<ReturnType<typeof createPauseRtcBrowserActor>>
const PauseBrowserObservation = z.strictObject({
  terminal: z.boolean(),
  failed: z.boolean(),
  proofsReady: z.boolean(),
  issued: z.boolean(),
  receipt: z
    .strictObject({
      transportId: z.uuid(),
      challengeId: z.uuid(),
      capabilityHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  diagnostics: PauseRtcReply.options[5].shape.diagnostics.optional(),
})
/** Failure receipts omit transport/challenge identifiers and capability hashes. */
export function pauseBrowserFailureProjection(value: unknown) {
  const parsed = PauseBrowserObservation.parse(value)
  return Object.freeze({
    terminal: parsed.terminal,
    failed: parsed.failed,
    proofsReady: parsed.proofsReady,
    issued: parsed.issued,
    receiptPresent: parsed.receipt !== undefined,
    diagnostics: parsed.diagnostics ?? null,
  })
}
/** Both maintained clients must authenticate their peers before HTTP-issued authority is accepted. */
export function verifyPauseRtcAcceptance(
  nativeValue: unknown,
  browserValue: unknown,
) {
  const native = PauseRtcReply.parse(nativeValue)
  const browser = PauseBrowserObservation.parse(browserValue)
  assert.equal(native.kind, 'observation')
  if (native.kind !== 'observation') throw Error('Pause observation missing')
  assert.equal(native.inboxReady, true)
  assert.equal(native.proofsReady, true)
  assert.equal(native.capabilityAccepted, true)
  assert.equal(native.terminal, false)
  assert.equal(native.failed, false)
  assert.equal(native.progress.firstFailure, null)
  assert.equal(browser.proofsReady, true)
  assert.equal(browser.issued, true)
  assert.equal(browser.terminal, false)
  assert.equal(browser.failed, false)
  assert.ok(browser.receipt)
  for (const diagnostics of [native.diagnostics, browser.diagnostics])
    assert.deepEqual(diagnostics, {
      certificateMatched: true,
      sentProofs: 1,
      receivedProofs: 1,
      terminal: false,
      commandsEnabled: false,
    })
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
  if (
    process.env.SIGNALLING_HTTPS_PAUSE_RTC_FIXTURE !== 'yes' ||
    process.env.SIGNALLING_HTTPS_DISPOSABLE !== 'yes'
  )
    throw Error('Explicit disposable RTC runtime window required')
  const parentLedger = process.env.SIGNALLING_HTTPS_LEDGER
  const path =
    process.env.PAUSE_AUTHENTICATED_RTC_LEDGER ??
    (parentLedger ? parentLedger + '.pause-rtc-resources.jsonl' : undefined)
  const checkout = await realpath(new URL('../..', import.meta.url))
  if (!path || !isAbsolute(path))
    throw Error('Private RTC resource ledger required')
  const { dirname, basename, join } = await import('node:path')
  const ledger = join(await realpath(dirname(path)), basename(path))
  const ca = await realpath(input.caPath)
  for (const candidate of [ledger, ca]) {
    const r = relative(checkout, candidate)
    if (!r.startsWith('../') && !isAbsolute(r))
      throw Error('Fixture files must stay outside checkout')
  }
  // A new receipt file cannot overwrite a previous task or follow a symlink.
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
    [new URL('./pause-rtc-connector-child.ts', import.meta.url).pathname],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        NODE_OPTIONS: '',
        NODE_EXTRA_CA_CERTS: input.caPath,
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
        WS_NO_BUFFER_UTIL: '1',
        WS_NO_UTF_8_VALIDATE: '1',
        PAUSE_AUTHENTICATED_RTC_CHILD: 'yes',
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
        resolve: (reply: PauseRtcReply) => void
        reject: (error: Error) => void
      }
    | undefined
  const fail = () => {
    failure = true
    pending?.reject(Error('RTC child rejected or closed'))
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
    // Drain without storing or logging native output, SDP, or library errors.
    errorBytes += chunk.byteLength
    if (errorBytes > 8192) fail()
  })
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.byteLength
    if (
      failure ||
      outputBytes > 65_536 ||
      output.byteLength + chunk.byteLength > PAUSE_RTC_IPC_BYTES
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
      const reply = PauseRtcReply.parse(
        parseBoundedJson(
          new TextDecoder('utf-8', { fatal: true }).decode(
            output.subarray(0, end),
          ),
          {
            maxBytes: PAUSE_RTC_IPC_BYTES,
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
  const request = async (command: PauseRtcCommand) => {
    if (
      failure ||
      disposing ||
      pending ||
      ++requests > 128 ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      throw Error('RTC child unavailable')
    const wire = JSON.stringify(PauseRtcCommand.parse(command)) + '\n'
    requestBytes += Buffer.byteLength(wire)
    if (Buffer.byteLength(wire) > PAUSE_RTC_IPC_BYTES || requestBytes > 65536)
      throw Error('IPC request limit')
    const reply = new Promise<PauseRtcReply>((resolve, reject) => {
      pending = { resolve, reject }
    })
    child.stdin.write(wire, (error) => {
      if (error) fail()
    })
    try {
      return await bounded(reply, input.signal, 2000)
    } catch {
      fail()
      throw Error('RTC child request failed')
    }
  }
  const dispose = () => {
    if (disposing) return disposing
    disposing = (async () => {
      // EOF requests graceful shutdown. close, rather than exit, proves drainage.
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
      pending?.reject(Error('RTC child disposed'))
      pending = undefined
      output = Buffer.alloc(0)
      await note(
        forced
          ? 'connector-child-owned-kill-close-drained'
          : 'connector-child-close-drained',
        child.pid,
      )
      if (forced || failure || receipt.code !== 0 || receipt.signal !== null)
        throw Error('RTC child cleanup required forced or failed exit')
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

/** Import and factory invocation are inert. Parent owns login, pairing, current
 * 0015 assignment readback, dedicated pause routes and the real HTTP issuer.
 * Browser HTTPS trust is the parent's isolated-fixture limitation; native WSS
 * retains strict CA verification. This fixture never sends a printer command.
 */
export function createPauseAuthenticatedRtcFixtureExtension(): SignallingFixtureExtension {
  let current:
    | {
        input: SignallingIdentityInput
        handles: FixtureIdentityHandles
        actor: JSHandle<BrowserActor>
        connector: Awaited<ReturnType<typeof connectorChild>>
        issuer: z.infer<typeof PauseRtcIssuer>
        note: Awaited<ReturnType<typeof resourceLedger>>
      }
    | undefined
  let used = false
  return Object.freeze({
    async identityHandles(input: SignallingIdentityInput) {
      input.signal.throwIfAborted()
      if (used) throw Error('Pause RTC fixture already used')
      if (
        process.env.SIGNALLING_HTTPS_PAUSE_RTC_FIXTURE !== 'yes' ||
        process.env.SIGNALLING_HTTPS_DISPOSABLE !== 'yes'
      )
        throw Error('Explicit disposable pause RTC runtime window required')
      if (
        new URL(input.origin).origin !== input.origin ||
        new URL(input.origin).protocol !== 'https:' ||
        new URL(input.origin).hostname !== '127.0.0.1' ||
        new URL(input.ownerPage.url()).origin !== input.origin
      )
        throw Error('Authenticated HTTPS loopback page required')
      used = true
      input = Object.freeze({ ...input })
      const issuer = PauseRtcIssuer.parse({
        issuer: input.origin,
        kid: 'pause-fixture',
        audience: 'open3dfarmmanager:pause',
        publicKeySpki: process.env.SIGNALLING_HTTPS_PAUSE_PUBLIC_KEY,
      })
      const note = await resourceLedger(input)
      await note('parent-baseline-required; no simulator or printer resources')
      const bundle = await promisify(execFile)(
        'bun',
        [
          'build',
          new URL('./pause-rtc-browser.ts', import.meta.url).pathname,
          '--target=browser',
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          signal: input.signal,
        },
      ).catch(() => {
        throw Error('Pause RTC browser bundle failed')
      })
      await note('browser-bundle-in-memory-completed; no generated output file')
      const route = input.origin + '/__pause_authenticated_rtc_fixture__.js'
      const serve: Parameters<typeof input.ownerPage.route>[1] = (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: bundle.stdout,
        })
      let connector: Awaited<ReturnType<typeof connectorChild>> | undefined
      let actor: JSHandle<BrowserActor> | undefined
      let disposal: Promise<void> | undefined
      const dispose = () => {
        if (disposal) return disposal
        disposal = (async () => {
          input.signal.removeEventListener('abort', abort)
          const results = await Promise.allSettled([
            bounded(
              (async () => {
                try {
                  await actor?.evaluate((actor) => actor.dispose())
                } finally {
                  await actor?.dispose()
                }
              })(),
              new AbortController().signal,
              3000,
            ),
            connector?.dispose(),
            bounded(
              input.ownerPage.unroute(route, serve),
              new AbortController().signal,
              3000,
            ),
          ])
          current = undefined
          await note(
            'pause-browser-actor-and-route-disposed; parent-owns-pages-and-context',
          )
          if (results.some((result) => result.status === 'rejected'))
            throw Error('Pause RTC fixture cleanup incomplete')
        })()
        return disposal
      }
      const abort = () => {
        void dispose().catch(() => {})
      }
      try {
        await input.ownerPage.route(route, serve)
        input.signal.throwIfAborted()
        actor = await bounded(
          input.ownerPage.evaluateHandle(
            async ({ path, scope }) => {
              const module: typeof import('./pause-rtc-browser.ts') =
                await import(path)
              return module.createPauseRtcBrowserActor(scope)
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
        await note('pause-browser-nonextractable-identity-created')
        const publicJwk = (
          await validateBrowserDevicePublicKey(
            await actor.evaluate((actor) => actor.publicJwk),
          )
        ).publicKey
        connector = await connectorChild(input, note)
        const identity = await connector.request({ kind: 'identity' })
        if (identity.kind !== 'identity')
          throw Error('Pause Connector identity missing')
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
                throw Error('Pause pairing scope mismatch')
              const reply = await ownedConnector.request({
                kind: 'pairing',
                challenge,
                origin,
                audience,
              })
              if (reply.kind !== 'pairing')
                throw Error('Pause pairing proof missing')
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
        throw Error('Pause RTC identity setup failed')
      }
    },
    async afterProvisioned(input: ProvisionedSignallingFixture) {
      const session = current
      if (
        !session ||
        session.handles !== input.identities ||
        session.input.ownerPage !== input.ownerPage ||
        session.input.ownerContext !== input.ownerContext ||
        session.input.signal !== input.signal ||
        session.input.accountId !== input.accountId ||
        session.input.farmId !== input.farmId ||
        session.input.origin !== input.origin ||
        session.input.audience !== input.audience ||
        session.input.caPath !== input.caPath ||
        input.claim.farm_id !== input.farmId
      )
        throw Error('Provisioned pause fixture scope mismatch')
      let completed = false
      let lastNative:
        Extract<PauseRtcReply, { kind: 'observation' }> | undefined
      let nativeFailureRecorded = false
      const retainNative = async () => {
        if (nativeFailureRecorded) return
        nativeFailureRecorded = true
        await session.note(
          'pause-native-failure-observation:' +
            JSON.stringify(
              lastNative ?? {
                observation: null,
                process: session.connector.exitDiagnostics(),
              },
            ),
        )
      }
      try {
        input.signal.throwIfAborted()
        const refs = snapshotAssignmentRefs(
          input.assignmentRefs,
          input.claim.agent_id,
        )
        assert.equal(
          refs.length,
          1,
          'Parent must read back exactly one current 0015 assignment',
        )
        const assignment = refs[0]
        assert.ok(assignment)
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
            throw Error('Pause Connector observation missing')
          lastNative = value
          if (value.failed || value.terminal) await retainNative()
          assert.equal(value.failed, false)
          assert.equal(value.terminal, false)
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
          const value = PauseBrowserObservation.parse(
            await session.actor.evaluate((actor) => actor.observe()),
          )
          assert.equal(value.failed, false)
          assert.equal(value.terminal, false)
          return value
        }
        const [native, browser] = await Promise.all([
          until(
            observeNative,
            (value) => value.capabilityAccepted,
            input.signal,
            10000,
          ),
          until(observeBrowser, (value) => value.issued, input.signal, 10000),
        ])
        verifyPauseRtcAcceptance(native, browser)
        await session.note(
          'authenticated-pause-rtc-both-proofs-certificates-http-issued-native-verifier-accepted; no printer command',
        )
        completed = true
      } catch (error) {
        await retainNative()
        try {
          const browser = await bounded(
            session.actor.evaluate((actor) => actor.observe()),
            new AbortController().signal,
            1000,
          )
          await session.note(
            'pause-browser-failure-observation:' +
              JSON.stringify(pauseBrowserFailureProjection(browser)),
          )
        } catch {
          await session.note('pause-browser-failure-observation-unavailable')
        }
        throw error
      } finally {
        try {
          await input.identities.dispose()
        } finally {
          if (!completed)
            await session.note(
              'authenticated-pause-rtc-incomplete; no acceptance claimed',
            )
        }
      }
    },
  })
}
