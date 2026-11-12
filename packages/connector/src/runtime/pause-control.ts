import { join } from 'node:path'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../control/command-journal.ts'
import {
  createPauseCommandRelay,
  type PauseRelayOutcome,
} from '../control/pause-command-relay.ts'
import { loadPauseIssuerKeys } from '../config/pause.ts'
import { credentialLookupId } from '../config/signalling.ts'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import type { RuntimeCredential } from '../config/credential.ts'
import type { ConnectorIdentity } from '../identity/store.ts'
import type { CachedAuthorityFreshness } from '../auth/offline-authority.ts'
import {
  PauseConnectorSignallingClient,
  type PauseConnectorSignallingScope,
} from '../cloud/pause-signalling-client.ts'
import { createPauseDriverRouter } from './pause-driver-router.ts'
import { runSignallingLifecycle } from './signalling.ts'

export type PauseControlDiagnostic =
  | { kind: 'pause-listening' }
  | { kind: 'pause-admitted' }
  | { kind: 'pause-denied'; reason: string }
  | { kind: 'pause-outcome'; outcome: PauseRelayOutcome }
  | { kind: 'pause-terminal'; reason: string }
  | { kind: 'pause-close-stalled'; waitedMs: number }

type ClientOptions = NonNullable<
  ConstructorParameters<typeof PauseConnectorSignallingClient>[1]
>
type PauseClient = Pick<
  PauseConnectorSignallingClient,
  'start' | 'close' | 'dispose' | 'sendPhase' | 'sendResult'
>

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000
/** Shutdown waits this long for driver settlement before reporting a stall. */
export const PAUSE_CLOSE_STALL_MS = 10000

function label(reason: string): string {
  return /^[a-zA-Z0-9:_-]{1,80}$/.test(reason) ? reason : 'unclassified'
}

/**
 * Production pause control path, composed exactly like the verified execution
 * fixture: authenticated pause RTC proofs open a relay peer; the relay verifies
 * the issued capability and the signed command, claims the durable local
 * journal (replay and busy refusal), and only then prepares the fixed Moonraker
 * driver for the single locally provisioned assignment. Every command runs at
 * most once: nothing is retried, queued or sent over HTTP.
 *
 * Runs until `signal` aborts or the credential expires, then closes the relay
 * and keeps the journal open until every driver attempt actually settled.
 */
export async function runPauseControl(input: {
  config: AgentRuntimeConfig
  credential: RuntimeCredential
  identity: ConnectorIdentity
  dataDirectory: string
  signal: AbortSignal
  onDiagnostic(value: PauseControlDiagnostic): void
  /**
   * Required offline lifetime gate: the frozen read-only view from
   * `createOfflineAuthority()`. Stale authority rejects every command.
   */
  freshness: CachedAuthorityFreshness
  /** Transport seam for tests. Defaults to the authenticated pause client. */
  createClient?: (
    scope: PauseConnectorSignallingScope,
    options: ClientOptions,
  ) => PauseClient
}): Promise<void> {
  const { config, credential } = input
  const pause = config.pause
  const assignmentId = pause?.control?.assignmentId
  if (!pause || !assignmentId) throw new Error('Pause control is not enabled')
  const printerBinding = config.bindingFor(assignmentId)
  if (!printerBinding)
    throw new Error('Pause control assignment is not provisioned locally')
  const issuers = await loadPauseIssuerKeys(pause)
  if (input.signal.aborted) return
  const jti = credentialLookupId(credential.device_token)
  const journal = openCommandJournal({
    directory: join(input.dataDirectory, 'pause-journal'),
    clock: Date.now,
  })
  const clock = Object.freeze({
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
  })
  const router = createPauseDriverRouter({
    allowedOrigins: config.collection.allowedOrigins,
    limits: config.collection.limits,
    clock,
    observe: (binding, observation) => relay.observe(binding, observation),
  })
  const relay = createPauseCommandRelay({
    authority: { issuers, freshness: input.freshness },
    clock,
    journal,
    driver: router,
    bindingFor: (id) => (id === assignmentId ? printerBinding : undefined),
  })
  const createClient =
    input.createClient ??
    ((scope, options) => new PauseConnectorSignallingClient(scope, options))
  function diagnostic(value: PauseControlDiagnostic) {
    try {
      input.onDiagnostic(value)
    } catch {
      // Diagnostics never change the command path.
    }
  }
  function admitted(result: Awaited<ReturnType<typeof relay.admitPeer>>) {
    diagnostic(
      result.ok
        ? { kind: 'pause-admitted' }
        : { kind: 'pause-denied', reason: result.reason },
    )
  }
  try {
    await runSignallingLifecycle({
      signal: input.signal,
      credentialExpiresAt: credential.expires_at,
      retryMinMs: RETRY_MIN_MS,
      retryMaxMs: RETRY_MAX_MS,
      createSession(onTerminal, onAdmitted) {
        const peerSignal = new AbortController()
        let transportId: string | undefined
        let ended = false
        const client: PauseClient = createClient(
          {
            url: pause.signalling.endpoint,
            origin: pause.signalling.origin,
            audience: pause.signalling.audience,
            credentialAudience: pause.signalling.credentialAudience,
            agentId: credential.agent_id,
            farmId: credential.farm_id,
            assignmentId,
            jti,
            token: credential.device_token,
            identity: input.identity,
          },
          {
            onInboxReady() {
              onAdmitted()
              diagnostic({ kind: 'pause-listening' })
            },
            onProofsReady(value) {
              if (transportId || ended) throw new Error('Unexpected proofs')
              transportId = value.binding.transport_id
              const opened = relay.openPeer({
                binding: value.binding,
                browserProofWire: value.browserProofWire,
                connectorProofWire: value.connectorProofWire,
                sendPhase: (message) => client.sendPhase(message),
                sendResult: (result) => client.sendResult(result),
                signal: peerSignal.signal,
              })
              if (!opened) throw new Error('Pause relay refused the peer')
            },
            onPhase(frame) {
              if (!transportId) return
              if (frame.t === 'control.capability')
                void relay
                  .admitPeer({ transportId, capabilityWire: frame.wire })
                  .then(admitted, () =>
                    diagnostic({ kind: 'pause-denied', reason: 'error' }),
                  )
              else if (frame.t === 'control.admission-proof')
                void relay
                  .admitPeer({ transportId, admissionProofWire: frame.wire })
                  .then(admitted, () =>
                    diagnostic({ kind: 'pause-denied', reason: 'error' }),
                  )
            },
            onData(frame) {
              if (frame.t !== 'control.command' || !transportId) return
              // One attempt only. The relay answers the peer; nothing retries.
              void relay.commandPeer({ transportId, wire: frame.wire }).then(
                (outcome) => diagnostic({ kind: 'pause-outcome', outcome }),
                () =>
                  diagnostic({
                    kind: 'pause-outcome',
                    outcome: 'outcome-unknown',
                  }),
              )
            },
            onTerminal(reason) {
              ended = true
              try {
                peerSignal.abort()
                if (transportId) relay.closePeer(transportId)
                diagnostic({ kind: 'pause-terminal', reason: label(reason) })
              } finally {
                onTerminal()
              }
            },
          },
        )
        return {
          start: () => client.start(),
          close: (reason) => client.close(reason),
          dispose: (ms) => client.dispose(ms),
        }
      },
    })
  } finally {
    relay.close()
    // A stalled driver close retains the journal; it is never force-closed.
    const stall = setTimeout(
      () =>
        diagnostic({
          kind: 'pause-close-stalled',
          waitedMs: PAUSE_CLOSE_STALL_MS,
        }),
      PAUSE_CLOSE_STALL_MS,
    )
    try {
      await relay.settled
    } finally {
      clearTimeout(stall)
    }
    closeCommandJournal(journal)
  }
}
