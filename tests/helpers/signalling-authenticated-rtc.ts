import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { appendFile, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { promisify } from 'node:util'
import type { JSHandle } from '@playwright/test'
import type {
  FixtureIdentityHandles,
  ProvisionedSignallingFixture,
  SignallingFixtureExtension,
  SignallingIdentityInput,
} from './signalling-https-fixture-contract.ts'
import type { createSignallingRtcBrowserActor } from './signalling-rtc-browser.ts'
import {
  RTC_FIXTURE_IPC_BYTES,
  RtcFixtureCommand,
  RtcFixtureReply,
  RtcFixtureDiagnostics,
} from './signalling-rtc-connector-child.ts'
import { waitFixtureClose } from './signalling-https-process.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { StatusMessage } from '../../packages/farm-protocol/src/channel.ts'
import { snapshotAssignmentRefs } from '../../packages/connector/src/webrtc/readonly-session.ts'

type BrowserActor = Awaited<ReturnType<typeof createSignallingRtcBrowserActor>>
type Closure = 'disconnect' | 'revocation'

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
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
      signal,
      150,
    )
  }
  throw Error('RTC fixture observation deadline')
}

async function resourceLedger(input: SignallingIdentityInput) {
  if (
    process.env.SIGNALLING_HTTPS_RTC_FIXTURE !== 'yes' ||
    process.env.SIGNALLING_HTTPS_DISPOSABLE !== 'yes'
  )
    throw Error('Explicit disposable RTC runtime window required')
  const parentLedger = process.env.SIGNALLING_HTTPS_LEDGER
  const path =
    process.env.SIGNALLING_AUTHENTICATED_RTC_LEDGER ??
    (parentLedger ? parentLedger + '.rtc-resources.jsonl' : undefined)
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
    [new URL('./signalling-rtc-connector-child.ts', import.meta.url).pathname],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        NODE_OPTIONS: '',
        NODE_EXTRA_CA_CERTS: input.caPath,
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
        WS_NO_BUFFER_UTIL: '1',
        WS_NO_UTF_8_VALIDATE: '1',
        SIGNALLING_AUTHENTICATED_RTC_CHILD: 'yes',
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
    requests = 0
  let pending:
    | {
        resolve: (reply: RtcFixtureReply) => void
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
      outputBytes > 131_072 ||
      output.byteLength + chunk.byteLength > RTC_FIXTURE_IPC_BYTES
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
      const reply = RtcFixtureReply.parse(
        parseBoundedJson(
          new TextDecoder('utf-8', { fatal: true }).decode(
            output.subarray(0, end),
          ),
          {
            maxBytes: RTC_FIXTURE_IPC_BYTES,
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
  const request = async (command: RtcFixtureCommand) => {
    if (
      failure ||
      disposing ||
      pending ||
      ++requests > 256 ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      throw Error('RTC child unavailable')
    const wire = JSON.stringify(RtcFixtureCommand.parse(command)) + '\n'
    if (Buffer.byteLength(wire) > RTC_FIXTURE_IPC_BYTES)
      throw Error('IPC request limit')
    const reply = new Promise<RtcFixtureReply>((resolve, reject) => {
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
          3000,
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
  return { request, dispose }
}

/** Test-only extension. Run the parent fixture separately for each
 * SIGNALLING_HTTPS_RTC_CLOSURE=disconnect|revocation (default: disconnect).
 * Each run needs a fresh real provisioning and a new external resource ledger.
 * HTTP login, approvals, pairing, actual 0015 registration/readback and both closures belong to parent.
 *
 * Runtime opt-ins and a pre-existing external ledger are required only when
 * identityHandles is invoked. Import/factory invocation creates no resources.
 * Browser ignoreHTTPSErrors is the parent's isolated-fixture limitation, never
 * browser TLS verification. Native WSS retains rejectUnauthorized and no Origin.
 */
export function createAuthenticatedRtcFixtureExtension(): SignallingFixtureExtension {
  let current:
    | {
        input: SignallingIdentityInput
        handles: FixtureIdentityHandles
        actor: JSHandle<BrowserActor>
        connector: Awaited<ReturnType<typeof connectorChild>>
        closure: Closure
        note: Awaited<ReturnType<typeof resourceLedger>>
      }
    | undefined
  const closure = process.env.SIGNALLING_HTTPS_RTC_CLOSURE ?? 'disconnect'
  if (closure !== 'disconnect' && closure !== 'revocation')
    throw Error('Invalid RTC closure scenario')
  let used = false
  return Object.freeze({
    async identityHandles(input: SignallingIdentityInput) {
      if (current || used) throw Error('RTC fixture already used')
      used = true
      input.signal.throwIfAborted()
      if (
        new URL(input.origin).origin !== input.origin ||
        new URL(input.origin).protocol !== 'https:' ||
        new URL(input.origin).hostname !== '127.0.0.1' ||
        new URL(input.ownerPage.url()).origin !== input.origin
      )
        throw Error('Authenticated HTTPS loopback page required')
      input = Object.freeze({ ...input })
      const note = await resourceLedger(input)
      await note(
        'source-baseline-required-parent-owned; no simulator or hardware resources',
      )
      const bundle = await promisify(execFile)(
        'bun',
        [
          'build',
          new URL('./signalling-rtc-browser.ts', import.meta.url).pathname,
          '--target=browser',
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          signal: input.signal,
        },
      ).catch(() => {
        throw Error('RTC browser bundle failed')
      })
      await note('browser-bundle-in-memory-completed; no generated output file')
      const route = input.origin + '/__authenticated_rtc_fixture__.js'
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
            (async () => {
              try {
                await actor?.evaluate((actor) => actor.close())
              } finally {
                await actor?.dispose()
              }
            })(),
            connector?.dispose(),
            input.ownerPage.unroute(route, serve),
          ])
          current = undefined
          await note(
            'browser-actor-and-route-disposed; parent-owns-pages-and-context',
          )
          if (results.some((result) => result.status === 'rejected'))
            throw Error('RTC fixture cleanup incomplete')
        })()
        return disposal
      }
      const abort = () => {
        void dispose().catch(() => {})
      }
      try {
        await input.ownerPage.route(route, serve)
        actor = await input.ownerPage.evaluateHandle(
          async ({ path, scope }) => {
            const module: typeof import('./signalling-rtc-browser.ts') =
              await import(path)
            return await module.createSignallingRtcBrowserActor(scope)
          },
          {
            path: route,
            scope: {
              accountId: input.accountId,
              farmId: input.farmId,
              origin: input.origin,
              audience: input.audience,
            },
          },
        )
        await note('browser-nonextractable-identity-created')
        const publicJwk = (
          await validateBrowserDevicePublicKey(
            await actor.evaluate((actor) => actor.publicJwk),
          )
        ).publicKey
        connector = await connectorChild(input, note)
        const identity = await connector.request({ kind: 'identity' })
        if (identity.kind !== 'identity')
          throw Error('Connector identity missing')
        const ownedActor = actor,
          ownedConnector = connector
        const handles: FixtureIdentityHandles = Object.freeze({
          browser: Object.freeze({
            publicJwk: Object.freeze({ ...publicJwk }),
            signEnrollment: (
              challenge: Parameters<
                FixtureIdentityHandles['browser']['signEnrollment']
              >[0],
            ) =>
              ownedActor.evaluate(
                (actor, challenge) => actor.signEnrollment(challenge),
                challenge,
              ),
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
                throw Error('Pairing scope mismatch')
              const reply = await ownedConnector.request({
                kind: 'pairing',
                challenge,
                origin,
                audience,
              })
              if (reply.kind !== 'pairing') throw Error('Pairing proof missing')
              return reply.signature
            },
          }),
          dispose,
        })
        current = {
          input,
          handles,
          actor,
          connector,
          closure,
          note,
        }
        input.signal.addEventListener('abort', abort, { once: true })
        input.signal.throwIfAborted()
        return handles
      } catch {
        await dispose()
        throw Error('RTC fixture identity setup failed')
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
        throw Error('Provisioned fixture scope mismatch')
      try {
        const refs = snapshotAssignmentRefs(
          input.assignmentRefs,
          input.claim.agent_id,
        )
        assert.equal(
          refs.length,
          1,
          'Parent must register and read back exactly one current 0015 assignment',
        )
        const browserIdentity = await validateBrowserDevicePublicKey(
          input.identities.browser.publicJwk,
        )
        if (browserIdentity.thumbprint !== input.browserThumbprint)
          throw Error('Provisioned browser thumbprint mismatch')
        const observeConnector = async () => {
          const reply = await session.connector.request({ kind: 'observe' })
          if (reply.kind !== 'observation')
            throw Error('Connector observation missing')
          return reply
        }
        const observeBrowser = () =>
          session.actor.evaluate((actor) => {
            const observation = actor.observe()
            return {
              ...observation,
              diagnosticsImmutable: Object.isFrozen(observation.diagnostics),
            }
          })
        const started = await session.connector.request({
          kind: 'start',
          origin: input.origin,
          audience: input.audience,
          claim: input.claim,
          assignmentRefs: refs.map((ref) => ({ ...ref })),
        })
        assert.equal(started.kind, 'started')
        await until(
          observeConnector,
          (value) => value.inboxReady && !value.diagnostics.terminal,
          input.signal,
          7500,
        )
        await session.actor.evaluate((actor, scope) => actor.start(scope), {
          browserKeyId: input.browserKeyId,
          agentId: input.claim.agent_id,
          assignmentRefs: refs,
        })
        const [native, browser] = await Promise.all([
          until(
            observeConnector,
            (value) =>
              value.verifiedAdmission &&
              value.published === 1 &&
              value.diagnostics.certificateMatched &&
              value.diagnostics.sentProofs === 1 &&
              value.diagnostics.receivedProofs === 1 &&
              !value.diagnostics.terminal,
            input.signal,
            7500,
          ),
          until(
            observeBrowser,
            (value) =>
              value.verifiedAdmission &&
              value.acceptedStatusCount === 1 &&
              !value.terminal,
            input.signal,
            7500,
          ),
        ])
        const browserDiagnostics = RtcFixtureDiagnostics.parse(
          browser.diagnostics,
        )
        for (const diagnostics of [native.diagnostics, browserDiagnostics])
          assert.deepEqual(diagnostics, {
            certificateMatched: true,
            sentProofs: 1,
            receivedProofs: 1,
            terminal: false,
            readOnly: true,
          })
        assert.equal(native.diagnosticsImmutable, true)
        assert.equal(browser.diagnosticsImmutable, true)
        const status = StatusMessage.parse(browser.latestStatus)
        assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 2048)
        assert.equal(status.seq, 0)
        assert.equal(status.printers.length, 1)
        assert.deepEqual(status.printers[0], {
          printerKey: refs[0]?.printerKey,
          state: 'idle',
          progress: 0,
          observedAt: status.printers[0]?.observedAt,
        })
        // Parent closures must await their actual server/proxy request + ack +
        // upgraded-socket close receipts. No local endpoint close can satisfy this.
        // Observe remaining local/server caps immediately before the fault.
        // Natural source/lease expiry must not stand in for remote closure.
        const beforeClosure = await observeConnector()
        assert.equal(beforeClosure.diagnostics.terminal, false)
        assert.ok(beforeClosure.sourceRemainingMs >= 8000)
        await bounded(
          session.closure === 'disconnect'
            ? input.disconnectSignalling()
            : input.revokeConnector(),
          input.signal,
          2000,
        )
        const [closedNative, closedBrowser] = await Promise.all([
          until(
            observeConnector,
            (value) => value.diagnostics.terminal && value.providerClosed,
            input.signal,
            3000,
          ),
          until(
            observeBrowser,
            (value) => value.terminal && value.diagnostics?.terminal === true,
            input.signal,
            3000,
          ),
        ])
        await bounded(
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
          input.signal,
          500,
        )
        const [laterNative, laterBrowser] = await Promise.all([
          observeConnector(),
          observeBrowser(),
        ])
        assert.deepEqual(laterNative, closedNative)
        assert.deepEqual(laterBrowser, closedBrowser)
        assert.equal(laterBrowser.acceptedStatusCount, 1)
        await session.note(
          `authenticated-rtc-${session.closure}-verified-status-and-remote-close`,
        )
      } finally {
        await input.identities.dispose()
      }
    },
  })
}
