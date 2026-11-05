import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import { pathToFileURL } from 'node:url'
import { BrowserDeviceUuid } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PairingPollResponse,
  PairingPublicKey,
} from '../../packages/farm-protocol/src/pairing.ts'
import {
  PairingProofChallenge,
  PairingProofCompletion,
  PairingProofOrigin,
  PairingProofAudience,
} from '../../packages/farm-protocol/src/pairing-proof.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import type { AuthenticatedConnectorSignallingClient } from '../../packages/connector/src/cloud/authenticated-signalling-client.ts'
import type { FarmStatusSender } from '../../packages/connector/src/webrtc/farm-status-sender.ts'

const Assignment = z.strictObject({
  assignmentId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  printerKey: z.string().min(1).max(128),
})
// Reuse the authoritative approved variant, including its token bounds.
const ApprovedClaim = PairingPollResponse.options[2]
export const RtcFixtureCommand = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('identity') }),
  z.strictObject({
    kind: z.literal('pairing'),
    challenge: PairingProofChallenge,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
  }),
  z.strictObject({
    kind: z.literal('start'),
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    claim: ApprovedClaim,
    assignmentRefs: z.array(Assignment).length(1),
  }),
  z.strictObject({ kind: z.literal('observe') }),
  z.strictObject({ kind: z.literal('advance-runtime') }),
  z.strictObject({ kind: z.literal('close') }),
])
export const RtcFixtureDiagnostics = z.strictObject({
  certificateMatched: z.boolean(),
  sentProofs: z.number().int().min(0).max(1),
  receivedProofs: z.number().int().min(0).max(1),
  terminal: z.boolean(),
  readOnly: z.literal(true),
})
export const RtcFixtureReply = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('identity'),
    publicKeySpki: PairingPublicKey,
    fingerprint: PairingProofChallenge.shape.fingerprint,
  }),
  z.strictObject({
    kind: z.literal('pairing'),
    signature: PairingProofCompletion.shape.signature,
  }),
  z.strictObject({ kind: z.literal('started') }),
  z.strictObject({
    kind: z.literal('runtime-observation'),
    requests: z.number().int().min(0).max(65),
    queued: z.number().int().min(0).max(64),
    failure: z.boolean(),
    settled: z.boolean(),
    directory: z.string().min(1).max(512),
    port: z.number().int().min(0).max(65535),
    admitted: z.number().int().min(0).max(64),
    listening: z.number().int().min(0).max(64),
    terminalReason: z
      .string()
      .regex(/^[a-zA-Z0-9:_-]{1,80}$/)
      .nullable(),
    packagedPid: z.number().int().nonnegative(),
    packagedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal('observation'),
    inboxReady: z.boolean(),
    terminalReason: z
      .string()
      .regex(/^[a-zA-Z0-9:_-]{1,80}$/)
      .nullable(),
    verifiedAdmission: z.boolean(),
    diagnosticsImmutable: z.boolean(),
    provider: z.literal('finite-synthetic-assigned-status'),
    published: z.number().int().min(0).max(1),
    providerClosed: z.boolean(),
    sourceRemainingMs: z.number().int().min(0).max(30000),
    diagnostics: RtcFixtureDiagnostics,
  }),
  z.strictObject({ kind: z.literal('closed') }),
  z.strictObject({ kind: z.literal('failed') }),
])
export type RtcFixtureCommand = z.infer<typeof RtcFixtureCommand>
export type RtcFixtureReply = z.infer<typeof RtcFixtureReply>
export const RTC_FIXTURE_IPC_BYTES = 16_384
export function parseRtcFixtureCommand(line: string) {
  return RtcFixtureCommand.parse(
    parseBoundedJson(line, {
      maxBytes: RTC_FIXTURE_IPC_BYTES,
      maxDepth: 6,
      maxValues: 128,
      maxStringChars: 8192,
    }),
  )
}

/** Explicit child entry only. Importing this module never creates an identity,
 * process, stream listener, timer, socket, or native RTC peer. */
async function run() {
  if (
    process.env.SIGNALLING_AUTHENTICATED_RTC_CHILD !== 'yes' ||
    process.env.WS_NO_BUFFER_UTIL !== '1' ||
    process.env.WS_NO_UTF_8_VALIDATE !== '1' ||
    !process.env.NODE_EXTRA_CA_CERTS ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  )
    throw Error('Explicit isolated child startup required')
  const { generateKeyPairSync } = await import('node:crypto')
  const { ConnectorIdentity } = await import(
    '../../packages/connector/src/identity/store.ts'
  )
  const runtimeFixture =
    process.env.SIGNALLING_HTTPS_RTC_RUNTIME === 'yes'
      ? await (
          await import('./signalling-runtime-moonraker.ts')
        ).createRuntimeMoonrakerFixture()
      : undefined
  const identity =
    runtimeFixture?.identity ??
    new ConnectorIdentity(generateKeyPairSync('ed25519').privateKey)
  let client: AuthenticatedConnectorSignallingClient | undefined
  let sender: FarmStatusSender | undefined
  let paired = false,
    started = false,
    closing = false,
    verifiedAdmission = false,
    published = 0,
    providerClosed = false,
    admissionDeadline = 0,
    sourceDeadline = 0
  let native:
    | typeof import('../../packages/connector/node_modules/node-datachannel')
    | undefined
  let pending = Buffer.alloc(0),
    receivedBytes = 0,
    requests = 0
  const signal = new AbortController()
  const stop = () => {
    if (closing) return
    closing = true
    clearTimeout(lifetime)
    for (const close of [
      () => signal.abort(),
      () => sender?.close('fixture-closed'),
      () => client?.close('fixture-closed'),
      () => process.stdin.destroy(),
    ]) {
      try {
        close()
      } catch {
        process.exitCode = 1
      }
    }
    void (async () => {
      try {
        await runtimeFixture?.close()
      } catch {
        process.exitCode = 1
      } finally {
        // Only this process owns the native module and peers.
        try {
          native?.cleanup()
        } catch {
          process.exitCode = 1
        }
      }
    })()
    pending = Buffer.alloc(0)
  }
  const lifetime = setTimeout(stop, 30_000)
  const output = (reply: RtcFixtureReply) => {
    const wire = JSON.stringify(RtcFixtureReply.parse(reply)) + '\n'
    if (!process.stdout.write(wire)) stop()
  }
  const handle = async (input: RtcFixtureCommand) => {
    switch (input.kind) {
      case 'identity': {
        output({
          kind: 'identity',
          publicKeySpki: identity.publicKeySpki,
          fingerprint: identity.fingerprint,
        })
        return
      }
      case 'pairing':
        if (paired || started) throw Error('Pairing already consumed')
        paired = true
        output({
          kind: 'pairing',
          signature: identity.signPairingProof({
            challenge: input.challenge,
            expectedOrigin: input.origin,
            expectedAudience: input.audience,
            now: Date.now(),
          }),
        })
        return
      case 'start': {
        if (!paired || started) throw Error('Start unavailable')
        const target = new URL(input.origin)
        if (target.protocol !== 'https:' || target.hostname !== '127.0.0.1')
          throw Error('Isolated HTTPS loopback required')
        const { snapshotAssignmentRefs } = await import(
          '../../packages/connector/src/webrtc/readonly-session.ts'
        )
        const refs = snapshotAssignmentRefs(
          input.assignmentRefs,
          input.claim.agent_id,
        )
        // A token selector is not authority. The maintained client and server
        // perform actual credential PoP and current authorization.
        const payload = parseBoundedJson(
          Buffer.from(
            input.claim.device_token.split('.')[1] ?? '',
            'base64url',
          ).toString('utf8'),
          { maxBytes: 8192, maxDepth: 4, maxValues: 64, maxStringChars: 4096 },
        )
        const { jti } = z.object({ jti: BrowserDeviceUuid }).parse(payload)
        const { AuthenticatedConnectorSignallingClient } = await import(
          '../../packages/connector/src/cloud/authenticated-signalling-client.ts'
        )
        const { FarmStatusSender } = await import(
          '../../packages/connector/src/webrtc/farm-status-sender.ts'
        )
        const { createRequire } = await import('node:module')
        if (closing) return
        if (
          runtimeFixture &&
          process.env.SIGNALLING_HTTPS_RTC_PACKAGED === 'yes'
        ) {
          started = true
          await runtimeFixture.start(input)
          output({ kind: 'started' })
          return
        }
        const ownedNative: NonNullable<typeof native> = createRequire(
          new URL('../../packages/connector/package.json', import.meta.url),
        )('node-datachannel')
        native = ownedNative
        ownedNative.initLogger('Fatal', () => {})
        // Complete module loading before client start so EOF cannot race a
        // pending native import against final native cleanup. No peer allocated.
        await import('../../packages/connector/src/webrtc/readonly-peer.ts')
        if (closing) return
        started = true
        if (runtimeFixture) {
          await runtimeFixture.start(input)
          output({ kind: 'started' })
          return
        }
        client = new AuthenticatedConnectorSignallingClient(
          {
            url:
              input.origin.replace('https:', 'wss:') +
              '/api/signalling/connector',
            origin: input.origin,
            audience: input.audience,
            farmId: input.claim.farm_id,
            agentId: input.claim.agent_id,
            jti,
            token: input.claim.device_token,
            identity,
          },
          {
            genuineStatus: { assignmentRefs: refs },
            onVerifiedAdmission: (admission) => {
              if (
                !Object.isFrozen(admission) ||
                !Object.isFrozen(admission.binding)
              )
                throw Error('Mutable admission')
              admissionDeadline = admission.deadlineMonoMs
              verifiedAdmission = true
            },
          },
        )
        sender = new FarmStatusSender({
          client,
          assignmentRefs: refs,
          signal: signal.signal,
          openSnapshots: ({ assignmentRefs, signal, onComplete }) => {
            // Finite synthetic observations under the parent's real 0015 mapping.
            // No Moonraker source, runtime composition, or command authority.
            const timer = setTimeout(() => {
              if (signal.aborted) return
              const now = performance.now()
              published++
              sourceDeadline = Math.min(now + 15000, admissionDeadline - 1)
              onComplete({
                complete: true,
                assignmentRefs,
                capturedAtMonoMs: now,
                validUntilMonoMs: sourceDeadline,
                printers: assignmentRefs.map(({ printerKey }) => ({
                  printerKey,
                  state: 'idle',
                  progress: 0,
                  observedAt: Date.now(),
                })),
              })
            }, 50)
            return {
              close() {
                clearTimeout(timer)
                providerClosed = true
              },
            }
          },
        })
        void sender.start().catch(() => {})
        output({ kind: 'started' })
        return
      }
      case 'observe': {
        if (runtimeFixture) {
          output(runtimeFixture.observe())
          return
        }
        if (!client) throw Error('Client unavailable')
        const diagnostics = client.diagnostics()
        const snapshot = client.snapshot()
        output({
          kind: 'observation',
          inboxReady: snapshot.phase === 'context-request',
          terminalReason: snapshot.reason
            ? /^[a-zA-Z0-9:_-]{1,80}$/.test(snapshot.reason)
              ? snapshot.reason
              : 'unclassified'
            : null,
          verifiedAdmission,
          diagnosticsImmutable: Object.isFrozen(diagnostics),
          provider: 'finite-synthetic-assigned-status',
          published,
          providerClosed,
          sourceRemainingMs: diagnostics.terminal
            ? 0
            : Math.max(0, Math.floor(sourceDeadline - performance.now())),
          diagnostics,
        })
        return
      }
      case 'advance-runtime':
        if (!runtimeFixture || !started)
          throw Error('Runtime fixture not started')
        runtimeFixture.advance()
        output(runtimeFixture.observe())
        return
      case 'close':
        stop()
        output({ kind: 'closed' })
        return
    }
  }
  let busy = false
  process.stdin.on('data', (chunk: Buffer) => {
    if (closing) return
    receivedBytes += chunk.byteLength
    if (
      busy ||
      receivedBytes > 65_536 ||
      pending.byteLength + chunk.byteLength > RTC_FIXTURE_IPC_BYTES
    ) {
      stop()
      return
    }
    pending = Buffer.concat([pending, chunk])
    const newline = pending.indexOf(10)
    if (newline < 0) return
    // Only one outstanding request; no queued closures or unbounded readline.
    if (newline !== pending.byteLength - 1 || ++requests > 256) {
      stop()
      return
    }
    const frame = pending
    pending = Buffer.alloc(0)
    busy = true
    void Promise.resolve()
      .then(() =>
        handle(
          parseRtcFixtureCommand(
            new TextDecoder('utf-8', { fatal: true }).decode(
              frame.subarray(0, newline),
            ),
          ),
        ),
      )
      .catch(() => {
        stop()
        output({ kind: 'failed' })
      })
      .finally(() => {
        busy = false
      })
  })
  process.stdin.on('end', stop)
  process.stdin.on('error', stop)
  process.stdout.on('error', stop)
  process.on('SIGTERM', stop)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void run().catch(() => {
    process.exitCode = 1
  })
