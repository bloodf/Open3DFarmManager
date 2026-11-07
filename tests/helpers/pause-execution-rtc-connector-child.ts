import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'
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
import {
  openCommandJournal,
  closeCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  createPauseCommandRelay,
  type PauseRelayOutcome,
} from '../../packages/connector/src/control/pause-command-relay.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'
import { PauseConnectorSignallingClient } from '../../packages/connector/src/cloud/pause-signalling-client.ts'
import { decodeCommandV2 } from '../../packages/farm-protocol/src/command-v2.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import type { PauseProofsReady } from '../../packages/connector/src/webrtc/pause-control-session.ts'

export const PAUSE_EXECUTION_RTC_IPC_BYTES = 16384

export const PauseExecutionRtcIssuer = z.strictObject({
  issuer: PairingProofAudience,
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  audience: PairingProofAudience,
  publicKeySpki: PairingPublicKey,
})

export const PauseExecutionRtcCommand = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('identity') }),
  z.strictObject({
    kind: z.literal('pairing'),
    challenge: PairingProofChallenge,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
  }),
  z.strictObject({
    kind: z.literal('start'),
    barrier: z.enum(['none', 'stale', 'reassigned', 'peer-closed', 'late-close']).default('none'),
    origin: PairingProofOrigin,
    credentialAudience: PairingProofAudience,
    issuer: PauseExecutionRtcIssuer,
    claim: PairingPollResponse.options[2],
    accountId: BrowserDeviceTextId,
    browserKeyId: BrowserDeviceUuid,
    assignment: z.strictObject({
      assignmentId: BrowserDeviceUuid,
      agentId: BrowserDeviceUuid,
      printerKey: z.string().min(1).max(128),
    }),
  }),
  z.strictObject({ kind: z.literal('release') }),
  z.strictObject({ kind: z.literal('owner-close') }),
  z.strictObject({ kind: z.literal('release-close') }),
  z.strictObject({ kind: z.literal('observe') }),
  z.strictObject({ kind: z.literal('close') }),
])
export type PauseExecutionRtcCommand = z.infer<typeof PauseExecutionRtcCommand>

const ProgressStage = z.enum([
  'created',
  'identity-returned',
  'pairing-signed',
  'moonraker-starting',
  'moonraker-ready',
  'driver-prepared',
  'relay-created',
  'client-starting',
  'inbox-ready',
  'proofs-ready',
  'relay-open-starting',
  'relay-open-completed',
  'admission-proof-received',
  'capability-received',
  'verifier-accepted',
  'command-received',
  'command-settled',
])

const FailureSource = z.enum([
  'client-start',
  'client-terminal',
  'verifier-denied',
  'verifier-error',
  'moonraker-start',
  'driver-prepare',
  'relay-open-failed',
  'command-error',
  'ipc-capacity',
  'ipc-frame',
  'ipc-command',
  'stdin-error',
  'stdout-error',
  'sigterm',
])

const ClientPhase = z.enum([
  'open',
  'inbox-challenge',
  'inbox-ready',
  'context-request',
  'context-challenge',
  'rtc-ready',
  'answer',
  'binding',
  'active',
  'other',
])

const TerminalReason = z.enum([
  'receive-capacity',
  'invalid-server-frame',
  'deadline',
  'context-expired',
  'lease-expired',
  'open-failed',
  'socket-error',
  'socket-closed',
  'socket-start',
  'socket-write',
  'send-failed',
  'disposed',
  'fixture-closed',
  'proofs-ready-callback',
  'late-peer',
  'binding-rejected',
  'transport-closed',
  'unexpected-channel',
  'unexpected-media',
  'channel-closed',
  'channel-error',
  'construction-failed',
  'description-changed',
  'offer-failed',
  'answer-failed',
  'certificate-or-binding',
  'auth-deadline',
  'expired',
  'capacity',
  'auth-failed',
  'local-proof',
  'remote-proof',
  'invalid-frame',
  'invalid-send',
  'send-state',
  'other',
])

const VerifierRejection = z.enum([
  'invalid-admission',
  'invalid-proof',
  'scope-mismatch',
  'untrusted-issuer',
  'signature-rejected',
  'expired-or-inactive',
  'unknown-peer',
])

export const PauseExecutionRtcProgress = z.strictObject({
  stage: ProgressStage,
  clientPhase: ClientPhase.nullable(),
  terminalReason: TerminalReason.nullable(),
  firstFailure: z
    .strictObject({
      source: FailureSource,
      stage: ProgressStage,
      clientPhase: ClientPhase.nullable(),
      terminalReason: TerminalReason.nullable(),
      verifierRejection: VerifierRejection.nullable(),
    })
    .nullable(),
})

export function createPauseExecutionRtcProgress() {
  let stage: z.infer<typeof ProgressStage> = 'created'
  let clientPhase: z.infer<typeof ClientPhase> | null = null
  let terminalReason: z.infer<typeof TerminalReason> | null = null
  let firstFailure: z.infer<typeof PauseExecutionRtcProgress>['firstFailure'] =
    null
  return Object.freeze({
    advance(value: z.infer<typeof ProgressStage>) {
      if (!firstFailure) stage = ProgressStage.parse(value)
    },
    phase(value: unknown) {
      const parsed = ClientPhase.safeParse(value)
      clientPhase = parsed.success ? parsed.data : 'other'
    },
    terminal(value: unknown) {
      if (terminalReason !== null) return
      const parsed = TerminalReason.safeParse(value)
      terminalReason = parsed.success ? parsed.data : 'other'
    },
    fail(source: z.infer<typeof FailureSource>, rejection?: unknown) {
      if (firstFailure) return
      const parsedRejection = VerifierRejection.safeParse(rejection)
      firstFailure = Object.freeze({
        source: FailureSource.parse(source),
        stage,
        clientPhase,
        terminalReason,
        verifierRejection: parsedRejection.success
          ? parsedRejection.data
          : null,
      })
    },
    snapshot() {
      return Object.freeze(
        PauseExecutionRtcProgress.parse({
          stage,
          clientPhase,
          terminalReason,
          firstFailure,
        }),
      )
    },
  })
}

const Diagnostics = z.strictObject({
  certificateMatched: z.boolean(),
  sentProofs: z.number().int().min(0).max(1),
  receivedProofs: z.number().int().min(0).max(1),
  terminal: z.boolean(),
  commandsEnabled: z.literal(true),
})

const RelayDiagnosticsSchema = z.strictObject({
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

export const PauseExecutionRtcReply = z.discriminatedUnion('kind', [
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
  z.strictObject({ kind: z.literal('released') }),
  z.strictObject({
    kind: z.literal('replay-result'),
    outcome: z.enum(['applied', 'rejected', 'outcome-unknown', 'not-sent']),
  }),
  z.strictObject({ kind: z.literal('closed') }),
  z.strictObject({ kind: z.literal('failed') }),
  z.strictObject({
    kind: z.literal('observation'),
    inboxReady: z.boolean(),
    proofsReady: z.boolean(),
    capabilityAccepted: z.boolean(),
    commandReceived: z.boolean(),
    commandsReceived: z.number().int().nonnegative(),
    prepareCalls: z.number().int().nonnegative().default(0),
    closeHeld: z.boolean().default(false),
    ownerSettled: z.boolean().default(false),
    pausesObserved: z.number().int().nonnegative(),
    latestPrintState: z.string().nullable(),
    commandId: z.string().uuid().nullable(),
    transportId: z.string().uuid().nullable(),
    commandOutcome: z
      .enum(['applied', 'rejected', 'outcome-unknown', 'not-sent'])
      .nullable(),
    terminal: z.boolean(),
    failed: z.boolean(),
    diagnostics: Diagnostics,
    relayDiagnostics: RelayDiagnosticsSchema.nullable(),
    progress: PauseExecutionRtcProgress,
  }),
])
export type PauseExecutionRtcReply = z.infer<typeof PauseExecutionRtcReply>

export function parsePauseExecutionRtcCommand(
  wire: string,
): PauseExecutionRtcCommand {
  return PauseExecutionRtcCommand.parse(
    parseBoundedJson(wire, {
      maxBytes: PAUSE_EXECUTION_RTC_IPC_BYTES,
      maxDepth: 6,
      maxValues: 128,
      maxStringChars: 8192,
    }),
  )
}

function credentialJti(token: string): string {
  const parts = token.split('.')
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? ''))
    throw Error('Fixture token format')
  return z
    .object({ jti: BrowserDeviceUuid })
    .parse(
      parseBoundedJson(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.from(parts[1]!, 'base64url'),
        ),
        { maxBytes: 12288, maxDepth: 4, maxValues: 64, maxStringChars: 4096 },
      ),
    ).jti
}

export async function run() {
  if (
    process.env.PAUSE_EXECUTION_RTC_CHILD !== 'yes' ||
    process.env.WS_NO_BUFFER_UTIL !== '1' ||
    process.env.WS_NO_UTF_8_VALIDATE !== '1' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '1'
  )
    throw Error('Explicit isolated execution child required')

  const pair = generateKeyPairSync('ed25519')
  const identity = new ConnectorIdentity(pair.privateKey)
  const progress = createPauseExecutionRtcProgress()

  let client: PauseConnectorSignallingClient | undefined
  let started = false
  let paired = false
  let disposal: Promise<void> | undefined
  let closing = false
  let failed = false
  let inboxReady = false
  let capabilityAccepted = false
  let commandReceived = false
  let commandsReceived = 0
  let ready: PauseProofsReady | undefined
  let transportId: string | undefined
  let lastCommandId: string | null = null
  let lastOutcome: PauseRelayOutcome | null = null
  let latestObservation: ControlObservation | null = null

  let moonrakerFixture: Awaited<ReturnType<typeof pauseFixture>> | undefined
  let journalDir: string | undefined
  let journal: ReturnType<typeof openCommandJournal> | undefined
  let relay: ReturnType<typeof createPauseCommandRelay> | undefined
  let releaseCommand: (() => void) | undefined
  let wallOffset = 0
  let prepareCalls = 0
  let closeHeld = false
  let ownerSettled = false
  let releaseClose: (() => void) | undefined
  const aborted = new AbortController()

  const fail = (
    source: z.infer<typeof FailureSource>,
    rejection?: unknown,
  ) => {
    failed = true
    progress.fail(source, rejection)
  }

  const output = (value: PauseExecutionRtcReply) => {
    process.stdout.write(JSON.stringify(value) + '\n')
  }

  const dispose = () => {
    if (disposal) return disposal
    closing = true
    releaseCommand?.()
    aborted.abort()
    relay?.close()
    disposal = (async () => {
      // Keep the journal and simulator alive until actual driver closure settles.
      // Rejection or a stalled close leaves ownership retained and blocks restart.
      await Promise.all([client?.dispose(2000), relay?.settled])
      await moonrakerFixture?.close()
      if (journal) closeCommandJournal(journal)
      if (journalDir) rmSync(journalDir, { recursive: true })
    })()
    return disposal
  }

  async function handle(input: PauseExecutionRtcCommand) {
    switch (input.kind) {
      case 'identity':
        progress.advance('identity-returned')
        output({
          kind: 'identity',
          publicKeySpki: identity.publicKeySpki,
          fingerprint: identity.fingerprint,
        })
        return

      case 'pairing':
        if (paired || started) throw Error('Repeated pairing')
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
        progress.advance('pairing-signed')
        return

      case 'start': {
        if (
          !paired ||
          started ||
          input.claim.agent_id !== input.assignment.agentId
        )
          throw Error('Invalid fixture start')
        started = true

        const url = new URL(input.origin)
        if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1')
          throw Error('Only disposable loopback target')

        const publicKey = await crypto.subtle.importKey(
          'spki',
          new Uint8Array(Buffer.from(input.issuer.publicKeySpki, 'base64url')),
          'Ed25519',
          false,
          ['verify'],
        )

        progress.advance('moonraker-starting')
        try {
          moonrakerFixture = await pauseFixture()
        } catch {
          fail('moonraker-start')
          throw Error('Moonraker loopback fixture failed')
        }
        progress.advance('moonraker-ready')

        // Resolve assignment exclusively through local registry; never accept a URL from peer/IPC.
        const registry = createPrinterBindingRegistry({
          allowedOrigins: [moonrakerFixture.origin],
        })
        const printerBinding = registry.provision({
          assignment_id: input.assignment.assignmentId,
          farm_id: input.claim.farm_id,
          agent_id: input.claim.agent_id,
          printer_key: input.assignment.printerKey,
          moonraker_origin: moonrakerFixture.origin,
        })

        journalDir = mkdtempSync(
          join(tmpdir(), 'pause-execution-relay-journal-'),
        )
        journal = openCommandJournal({
          directory: journalDir,
          clock: Date.now,
        })

        let release: () => void = () => {}
        const deliveryBarrier = (input.barrier === 'none' || input.barrier === 'late-close')
          ? Promise.resolve()
          : new Promise<void>((resolve) => { release = resolve })
        releaseCommand = () => {
          if (input.barrier === 'stale') wallOffset = 60000
          if (input.barrier === 'reassigned') registry.retire(printerBinding)
          if (input.barrier === 'peer-closed') aborted.abort()
          release()
        }
        const router = createPauseDriverRouter({
          allowedOrigins: [moonrakerFixture.origin],
          limits: {
            maxMessageBytes: 4096,
            connectTimeoutMs: 1500,
            requestTimeoutMs: 1500,
            staleAfterMs: 4000,
            reconnectMinMs: 100,
            reconnectMaxMs: 100,
          },
          clock: { monotonicNow: () => performance.now() },
          observe: (binding, obs) => {
            if (obs) latestObservation = obs
            return relay?.observe(binding, obs) ?? false
          },
        })

        relay = createPauseCommandRelay({
          authority: {
            issuers: [
              {
                issuer: input.issuer.issuer,
                kid: input.issuer.kid,
                publicKey,
              },
            ],
          },
          clock: { wallNow: () => Date.now() + wallOffset, monotonicNow: () => performance.now() },
          journal,
          driver: {
            ...router,
            prepare(value) {
              prepareCalls++
              return router.prepare(value)
            },
            async closeAttempt(binding) {
              await router.closeAttempt(binding)
              if (input.barrier === 'late-close') {
                closeHeld = true
                await new Promise<void>((resolve) => { releaseClose = resolve })
                closeHeld = false
              }
            },
          },
          bindingFor: (id) =>
            id === input.assignment.assignmentId ? printerBinding : undefined,
        })
        progress.advance('relay-created')

        url.protocol = 'wss:'
        url.pathname = '/api/signalling/pause-connector'

        client = new PauseConnectorSignallingClient(
          {
            url: url.href,
            origin: input.origin,
            audience: input.issuer.audience,
            credentialAudience: input.credentialAudience,
            agentId: input.claim.agent_id,
            farmId: input.claim.farm_id,
            assignmentId: input.assignment.assignmentId,
            jti: credentialJti(input.claim.device_token),
            token: input.claim.device_token,
            identity,
            accountId: input.accountId,
            keyId: input.browserKeyId,
          },
          {
            onInboxReady: () => {
              inboxReady = true
              progress.advance('inbox-ready')
            },
            onProofsReady: (value) => {
              if (ready || !relay || closing)
                throw Error('Unexpected control proofs')
              ready = value
              transportId = value.binding.transport_id
              progress.advance('proofs-ready')
              progress.advance('relay-open-starting')

              const opened = relay.openPeer({
                binding: value.binding,
                browserProofWire: value.browserProofWire,
                connectorProofWire: value.connectorProofWire,
                sendPhase: (message) => client?.sendPhase(message) ?? false,
                sendResult: (result) => client?.sendResult(result) ?? false,
                signal: aborted.signal,
              })

              if (!opened) {
                fail('relay-open-failed')
                throw Error('Relay openPeer refused')
              }
              progress.advance('relay-open-completed')
            },
            onPhase: (frame) => {
              if (!relay || !transportId) return
              if (frame.t === 'control.capability') {
                progress.advance('capability-received')
                void relay
                  .admitPeer({
                    transportId,
                    capabilityWire: frame.wire,
                  })
                  .then((res) => {
                    if (closing) return
                    if (res.ok) {
                      capabilityAccepted = true
                      progress.advance('verifier-accepted')
                    } else {
                      fail('verifier-denied', res.reason)
                    }
                  })
                  .catch(() => {
                    if (!closing) fail('verifier-error')
                  })
              } else if (frame.t === 'control.admission-proof') {
                progress.advance('admission-proof-received')
                void relay
                  .admitPeer({
                    transportId,
                    admissionProofWire: frame.wire,
                  })
                  .then((res) => {
                    if (closing) return
                    if (res.ok) {
                      capabilityAccepted = true
                      progress.advance('verifier-accepted')
                    } else {
                      fail('verifier-denied', res.reason)
                    }
                  })
                  .catch(() => {
                    if (!closing) fail('verifier-error')
                  })
              }
            },
            onData: (frame) => {
              if (frame.t === 'control.command' && relay && transportId) {
                commandReceived = true
                commandsReceived++
                progress.advance('command-received')
                try {
                  const decoded = decodeCommandV2(frame.wire)
                  lastCommandId = decoded.cmd_id
                } catch {
                  // Decoding failure will be handled by relay
                }
                const owner = relay
                const peer = transportId
                void deliveryBarrier.then(() => owner.commandPeer({
                    transportId: peer,
                    wire: frame.wire,
                  }))
                  .then((outcome) => {
                    lastOutcome = outcome
                    progress.advance('command-settled')
                  })
                  .catch(() => {
                    if (!closing) fail('command-error')
                  })
              }
            },
            onTerminal: (reason) => {
              progress.terminal(reason)
              if (client) progress.phase(client.snapshot().phase)
              aborted.abort()
              if (transportId && relay) relay.closePeer(transportId)
              if (!closing && !capabilityAccepted) fail('client-terminal')
              closing = true
            },
          },
        )

        progress.advance('client-starting')
        void client.start().catch(() => fail('client-start'))
        output({ kind: 'started' })
        return
      }

      case 'owner-close':
        relay?.close()
        void relay?.settled.then(() => { ownerSettled = true })
        output({ kind: 'released' })
        return
      case 'release-close':
        releaseClose?.()
        output({ kind: 'released' })
        return
      case 'release':
        releaseCommand?.()
        output({ kind: 'released' })
        return

      case 'observe': {
        const diagnostics = client?.diagnostics()
        if (client) progress.phase(client.snapshot().phase)
        const counts = moonrakerFixture?.counts()
        const relayDiag = relay?.diagnostics() ?? null
        output({
          kind: 'observation',
          inboxReady,
          proofsReady: !!ready,
          capabilityAccepted:
            capabilityAccepted &&
            (relayDiag?.admitted ?? 0) > 0 &&
            !closing &&
            !failed,
          commandReceived,
          commandsReceived,
          prepareCalls,
          closeHeld,
          ownerSettled,
          pausesObserved: counts?.pauses ?? 0,
          latestPrintState: latestObservation?.printState ?? null,
          commandId: lastCommandId,
          transportId: transportId ?? null,
          commandOutcome: lastOutcome,
          terminal: closing,
          failed,
          progress: progress.snapshot(),
          diagnostics: {
            certificateMatched: diagnostics?.certificateMatched ?? false,
            sentProofs: diagnostics?.sentProofs ?? 0,
            receivedProofs: diagnostics?.receivedProofs ?? 0,
            terminal: diagnostics?.terminal ?? closing,
            commandsEnabled: true,
          },
          relayDiagnostics: relayDiag,
        })
        return
      }

      case 'close':
        await dispose()
        output({ kind: 'closed' })
        process.stdin.pause()
        return
    }
  }

  let pending = Buffer.alloc(0),
    total = 0,
    count = 0,
    busy = false

  process.stdin.on('data', (chunk: Buffer) => {
    total += chunk.byteLength
    if (
      busy ||
      total > 65536 ||
      pending.byteLength + chunk.byteLength > PAUSE_EXECUTION_RTC_IPC_BYTES
    ) {
      fail('ipc-capacity')
      return
    }
    pending = Buffer.concat([pending, chunk])
    const newline = pending.indexOf(10)
    if (newline < 0) return
    if (newline !== pending.byteLength - 1 || ++count > 128) {
      fail('ipc-frame')
      return
    }
    const frame = pending
    pending = Buffer.alloc(0)
    busy = true
    void Promise.resolve()
      .then(() =>
        handle(
          parsePauseExecutionRtcCommand(
            new TextDecoder('utf-8', { fatal: true }).decode(
              frame.subarray(0, newline),
            ),
          ),
        ),
      )
      .catch(() => {
        output({ kind: 'failed' })
        fail('ipc-command')
      })
      .finally(() => {
        busy = false
      })
  })

  process.stdin.on('end', () => {
    void dispose().catch(() => {
      process.exitCode = 1
    })
  })
  process.stdin.on('error', () => fail('stdin-error'))
  process.stdout.on('error', () => fail('stdout-error'))
  process.on('SIGTERM', () => fail('sigterm'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().catch(() => {
    process.exitCode = 1
  })
}
