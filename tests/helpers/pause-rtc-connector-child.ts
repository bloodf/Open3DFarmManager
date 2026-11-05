import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
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
  createPauseCapabilityVerifier,
  type PauseAdmissionToken,
  type PauseCapabilityHandle,
  type PauseCapabilityRejection,
} from '../../packages/connector/src/auth/pause-capability.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import type { PauseProofsReady } from '../../packages/connector/src/webrtc/pause-control-session.ts'
import type { PauseConnectorSignallingClient } from '../../packages/connector/src/cloud/pause-signalling-client.ts'

export const PAUSE_RTC_IPC_BYTES = 16384
export const PauseRtcIssuer = z.strictObject({
  issuer: PairingProofAudience,
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  audience: PairingProofAudience,
  publicKeySpki: PairingPublicKey,
})
export const PauseRtcCommand = z.discriminatedUnion('kind', [
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
    credentialAudience: PairingProofAudience,
    issuer: PauseRtcIssuer,
    claim: PairingPollResponse.options[2],
    accountId: BrowserDeviceTextId,
    browserKeyId: BrowserDeviceUuid,
    assignment: z.strictObject({
      assignmentId: BrowserDeviceUuid,
      agentId: BrowserDeviceUuid,
      printerKey: z.string().min(1).max(128),
    }),
  }),
  z.strictObject({ kind: z.literal('observe') }),
  z.strictObject({ kind: z.literal('close') }),
])
export type PauseRtcCommand = z.infer<typeof PauseRtcCommand>
const ProgressStage = z.enum([
  'created',
  'identity-returned',
  'pairing-signed',
  'client-starting',
  'inbox-ready',
  'proofs-ready',
  'admission-starting',
  'admission-begun',
  'nonce-sending',
  'nonce-sent',
  'admission-proof-received',
  'capability-received',
  'verifier-starting',
  'verifier-accepted',
])
const FailureSource = z.enum([
  'client-start',
  'client-terminal',
  'verifier-denied',
  'verifier-error',
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
] satisfies readonly PauseCapabilityRejection[])
export const PauseRtcProgress = z.strictObject({
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
/** Fixed metadata only. Cleanup cannot overwrite the first failure or its stage. */
export function createPauseRtcProgress() {
  let stage: z.infer<typeof ProgressStage> = 'created'
  let clientPhase: z.infer<typeof ClientPhase> | null = null
  let terminalReason: z.infer<typeof TerminalReason> | null = null
  let firstFailure: z.infer<typeof PauseRtcProgress>['firstFailure'] = null
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
        PauseRtcProgress.parse({
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
  commandsEnabled: z.literal(false),
})
export const PauseRtcReply = z.discriminatedUnion('kind', [
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
  z.strictObject({ kind: z.literal('closed') }),
  z.strictObject({ kind: z.literal('failed') }),
  z.strictObject({
    kind: z.literal('observation'),
    inboxReady: z.boolean(),
    proofsReady: z.boolean(),
    capabilityAccepted: z.boolean(),
    terminal: z.boolean(),
    failed: z.boolean(),
    diagnostics: Diagnostics,
    progress: PauseRtcProgress,
  }),
])
export type PauseRtcReply = z.infer<typeof PauseRtcReply>
export function parsePauseRtcCommand(wire: string): PauseRtcCommand {
  return PauseRtcCommand.parse(
    parseBoundedJson(wire, {
      maxBytes: PAUSE_RTC_IPC_BYTES,
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
async function run() {
  if (
    process.env.PAUSE_AUTHENTICATED_RTC_CHILD !== 'yes' ||
    process.env.WS_NO_BUFFER_UTIL !== '1' ||
    process.env.WS_NO_UTF_8_VALIDATE !== '1' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '1'
  )
    throw Error('Explicit isolated child required')
  const pair = generateKeyPairSync('ed25519'),
    identity = new ConnectorIdentity(pair.privateKey)
  const progress = createPauseRtcProgress()
  let client: PauseConnectorSignallingClient | undefined,
    started = false,
    paired = false,
    closing = false,
    failed = false,
    inboxReady = false,
    ready: PauseProofsReady | undefined
  let verifier: ReturnType<typeof createPauseCapabilityVerifier> | undefined,
    peer:
      | ReturnType<
          ReturnType<typeof createPauseCapabilityVerifier>['createPeer']
        >
      | undefined
  let admission: PauseAdmissionToken | undefined,
    accepted: PauseCapabilityHandle | undefined,
    admissionWire: string | undefined,
    capabilityWire: string | undefined,
    admitting: Promise<void> | undefined
  let disposal: Promise<void> | undefined
  const dispose = () => {
    if (disposal) return disposal
    closing = true
    peer?.close()
    client?.close('fixture-closed')
    disposal = (async () => {
      await Promise.all([admitting, client?.dispose(3000)])
    })()
    return disposal
  }
  const fail = (
    source: z.infer<typeof FailureSource>,
    rejection?: PauseCapabilityRejection,
  ) => {
    if (client) progress.phase(client.snapshot().phase)
    progress.fail(source, rejection)
    failed = true
    void dispose().catch(() => {
      process.exitCode = 1
    })
  }
  function output(value: PauseRtcReply) {
    const wire = JSON.stringify(PauseRtcReply.parse(value)) + '\n'
    if (
      Buffer.byteLength(wire) > PAUSE_RTC_IPC_BYTES ||
      process.stdout.writableLength + Buffer.byteLength(wire) > 32768
    )
      throw Error('Fixture output bound')
    process.stdout.write(wire)
  }
  function maybeAdmit() {
    if (
      admitting ||
      !admission ||
      !ready ||
      !admissionWire ||
      !capabilityWire ||
      !verifier ||
      closing
    )
      return
    const current = verifier,
      token = admission,
      proofs = ready,
      a = admissionWire,
      c = capabilityWire
    admitting = (async () => {
      progress.advance('verifier-starting')
      const result = await current.admit(token, {
        browserProofWire: proofs.browserProofWire,
        connectorProofWire: proofs.connectorProofWire,
        admissionProofWire: a,
        capabilityWire: c,
      })
      if (closing) return
      if (!result.ok) {
        fail('verifier-denied', result.reason)
        return
      }
      accepted = result.handle
      progress.advance('verifier-accepted')
    })().catch(() => {
      if (!closing) fail('verifier-error')
    })
  }
  async function handle(input: PauseRtcCommand) {
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
        verifier = createPauseCapabilityVerifier({
          issuers: [
            { issuer: input.issuer.issuer, kid: input.issuer.kid, publicKey },
          ],
          clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
        })
        peer = verifier.createPeer(1)
        // Local fixture-only mapping, never contacted and never a machine-verified configuration claim.
        const registry = createPrinterBindingRegistry({
          allowedOrigins: ['http://127.0.0.1:1'],
        })
        const printer = registry.provision({
          assignment_id: input.assignment.assignmentId,
          farm_id: input.claim.farm_id,
          agent_id: input.claim.agent_id,
          printer_key: input.assignment.printerKey,
          moonraker_origin: 'http://127.0.0.1:1',
        })
        const { PauseConnectorSignallingClient: Client } = await import(
          '../../packages/connector/src/cloud/pause-signalling-client.ts'
        )
        url.protocol = 'wss:'
        url.pathname = '/api/signalling/pause-connector'
        client = new Client(
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
              if (ready || !verifier || !peer || closing)
                throw Error('Unexpected control proofs')
              ready = value
              progress.advance('proofs-ready')
              progress.advance('admission-starting')
              const fresh = verifier.beginAdmission({
                binding: value.binding,
                printerBinding: printer,
                peer: peer.peer,
              })
              admission = fresh.token
              progress.advance('admission-begun')
              progress.advance('nonce-sending')
              if (
                !client?.sendPhase({
                  t: 'control.admission-nonce',
                  admission_nonce: fresh.challenge.admissionNonce,
                  issued_at: fresh.challenge.issuedAt,
                  expires_at: fresh.challenge.expiresAt,
                })
              )
                throw Error('Nonce send failed')
              progress.advance('nonce-sent')
            },
            onPhase: (frame) => {
              if (frame.t === 'control.admission-proof' && !admissionWire) {
                admissionWire = frame.wire
                progress.advance('admission-proof-received')
              } else if (frame.t === 'control.capability' && !capabilityWire) {
                capabilityWire = frame.wire
                progress.advance('capability-received')
              } else throw Error('Unexpected fixture phase')
              maybeAdmit()
            },
            onTerminal: (reason) => {
              progress.terminal(reason)
              if (client) progress.phase(client.snapshot().phase)
              if (!accepted && !closing) fail('client-terminal')
              closing = true
              peer?.close()
            },
          },
        )
        progress.advance('client-starting')
        void client.start().catch(() => fail('client-start'))
        output({ kind: 'started' })
        return
      }
      case 'observe': {
        const diagnostics = client?.diagnostics()
        if (client) progress.phase(client.snapshot().phase)
        output({
          kind: 'observation',
          inboxReady,
          proofsReady: !!ready,
          capabilityAccepted:
            !!accepted &&
            !!verifier?.inspectAt(accepted, Date.now(), performance.now()).ok,
          terminal: closing,
          failed,
          progress: progress.snapshot(),
          diagnostics: {
            certificateMatched: diagnostics?.certificateMatched ?? false,
            sentProofs: diagnostics?.sentProofs ?? 0,
            receivedProofs: diagnostics?.receivedProofs ?? 0,
            terminal: diagnostics?.terminal ?? closing,
            commandsEnabled: false,
          },
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
      pending.byteLength + chunk.byteLength > PAUSE_RTC_IPC_BYTES
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
          parsePauseRtcCommand(
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void run().catch(() => {
    process.exitCode = 1
  })
