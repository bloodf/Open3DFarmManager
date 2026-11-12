import { openLocalStatus } from '../status/local.ts'
import type { SpoolmanSnapshot } from './spoolman-provider.ts'
import { loadExistingIdentity } from '../identity/store.ts'
import { readRuntimeCredential } from '../config/credential.ts'
import { readAgentRuntimeConfig } from '../config/runtime.ts'
import { openScopedTelemetryQueue } from './queue-scope.ts'
import type { Diagnostic as CollectionDiagnostic } from './collect.ts'
import type { TelemetrySender } from '../cloud/drain.ts'
import { credentialLookupId } from '../config/signalling.ts'
import { createFarmSnapshotSource } from './farm-snapshot-provider.ts'
import type { PauseControlDiagnostic } from './pause-control.ts'
import { recordAuthorityStale } from './pause-authority-audit.ts'
import {
  createOfflineAuthority,
  type OfflineAuthorityStaleReason,
} from '../auth/offline-authority.ts'

type AgentDiagnostic =
  | CollectionDiagnostic
  | PauseControlDiagnostic
  | { kind: 'pause-authority-stale'; reason: OfflineAuthorityStaleReason }
  | { kind: 'pause-failed' }
  | { kind: 'pause-audit-failed' }
  | { kind: 'credential-expired' }
  | { kind: 'readonly-admitted' }
  | { kind: 'readonly-listening' }
  | { kind: 'readonly-terminal'; reason: string }
  | { kind: 'delivery'; status: 'delivered' | 'retained'; count: number }
  | { kind: 'drain-loss'; expired: number; capacity: number }
  | {
      kind: 'agent-summary'
      delivered: number
      retries: number
      expired: number
      capacity: number
      credentialExpired: boolean
    }

let bootstrapped = false
function bootstrapNetworking() {
  if (bootstrapped) return
  process.env.WS_NO_BUFFER_UTIL = '1'
  process.env.WS_NO_UTF_8_VALIDATE = '1'
  bootstrapped = true
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}
function untilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/** One scoped queue, one maintained authenticated sender, one serial drain loop. */
export async function runConnectorAgent(input: {
  statusPort?: number
  configPath: string
  credentialPath: string
  dataDirectory: string
  signal: AbortSignal
  onInventory?: (value: SpoolmanSnapshot) => void
  onDiagnostic: (value: AgentDiagnostic) => void
}): Promise<void> {
  const identity = loadExistingIdentity(input.dataDirectory)
  const credential = readRuntimeCredential(
    input.credentialPath,
    identity.fingerprint,
    Date.now(),
  )
  const config = readAgentRuntimeConfig(input.configPath, credential)
  const lookupId = config.signalling
    ? credentialLookupId(credential.device_token)
    : undefined
  if (input.signal.aborted) return
  bootstrapNetworking()
  const { createAuthenticatedTelemetrySender } =
    await import('../cloud/authenticated-http-telemetry.ts')
  const send = createAuthenticatedTelemetrySender({
    endpoint: config.telemetry.endpoint,
    audience: config.telemetry.audience,
    timeoutMs: config.telemetry.timeoutMs,
    token: credential.device_token,
    farmId: credential.farm_id,
    agentId: credential.agent_id,
    identity,
  })
  if (Date.now() >= credential.expires_at)
    throw new Error('Runtime credential expired before startup')
  if (input.signal.aborted) return
  const queue = openScopedTelemetryQueue({
    dataDirectory: input.dataDirectory,
    config,
    credential,
    now: Date.now(),
  })
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let failure: { error: unknown } | undefined
  let diagnosticBudget = 1024
  const totals = {
    delivered: 0,
    retries: 0,
    expired: 0,
    capacity: 0,
    credentialExpired: false,
  }
  function diagnostic(value: AgentDiagnostic) {
    if (value.kind === 'summary' || diagnosticBudget-- > 0)
      input.onDiagnostic(value)
  }
  function fail(error: unknown) {
    failure ??= { error }
    controller.abort()
  }
  const tasks: Promise<void>[] = []
  const refs = config.assignments.map((assignment) => ({
    assignmentId: assignment.assignment_id,
    agentId: assignment.agent_id,
    printerKey: assignment.printer_key,
  }))
  let localStatus: Awaited<ReturnType<typeof openLocalStatus>> | undefined
  let snapshots: ReturnType<typeof createFarmSnapshotSource> | undefined
  try {
    if (input.statusPort !== undefined) {
      localStatus = await openLocalStatus({
        port: input.statusPort,
        read: () => ({
          queueDepth: queue.depth,
          delivered: totals.delivered,
          retries: totals.retries,
          credentialExpired:
            totals.credentialExpired || Date.now() >= credential.expires_at,
        }),
        onError: fail,
      })
    }
    if (signal.aborted) return
    snapshots = config.signalling
      ? createFarmSnapshotSource({ assignmentRefs: refs })
      : undefined
    const { collectIntoQueue } = await import('./collect.ts')
    const { drainTelemetryOnce } = await import('../cloud/drain.ts')
    // Own budget: pause traffic never starves read-only diagnostics.
    let pauseBudget = 256
    const pauseDiagnostic = (value: AgentDiagnostic) => {
      if (pauseBudget-- > 0) input.onDiagnostic(value)
    }
    // Offline authority for the pause path. Only the credential-authenticated
    // read-only inbox confirms it; without `signalling` it stays stale and
    // every pause command is rejected. Never stub it as fresh.
    const offline = config.pause?.control
      ? createOfflineAuthority({
          onStale(reason) {
            pauseDiagnostic({ kind: 'pause-authority-stale', reason })
            recordAuthorityStale(input.dataDirectory, reason, pauseDiagnostic)
          },
        })
      : undefined
    if (config.signalling && lookupId && snapshots) {
      const { AuthenticatedConnectorSignallingClient } =
        await import('../cloud/authenticated-signalling-client.ts')
      const { FarmStatusSender } =
        await import('../webrtc/farm-status-sender.ts')
      const { runSignallingLifecycle } = await import('./signalling.ts')
      const signalling = config.signalling
      const source = snapshots
      tasks.push(
        runSignallingLifecycle({
          signal,
          credentialExpiresAt: credential.expires_at,
          retryMinMs: signalling.retryMinMs,
          retryMaxMs: signalling.retryMaxMs,
          createSession(onTerminal, onAdmitted) {
            const client = new AuthenticatedConnectorSignallingClient(
              {
                url: signalling.endpoint,
                origin: signalling.origin,
                audience: signalling.audience,
                agentId: credential.agent_id,
                farmId: credential.farm_id,
                jti: lookupId,
                token: credential.device_token,
                identity,
              },
              {
                genuineStatus: { assignmentRefs: refs },
                onInboxReady() {
                  onAdmitted()
                  diagnostic({ kind: 'readonly-listening' })
                },
                // Callbacks must return nothing; a refused confirm stays stale.
                onAuthorityConfirm(serverSeq) {
                  offline?.confirm(
                    { wall: Date.now(), mono: performance.now() },
                    serverSeq,
                  )
                },
                onAuthorityRevoked(serverSeq) {
                  offline?.revoke(serverSeq)
                },
                onVerifiedAdmission: () =>
                  diagnostic({ kind: 'readonly-admitted' }),
                onTerminal(reason) {
                  try {
                    diagnostic({
                      kind: 'readonly-terminal',
                      reason: /^[a-zA-Z0-9:_-]{1,80}$/.test(reason)
                        ? reason
                        : 'unclassified',
                    })
                  } finally {
                    onTerminal()
                  }
                },
              },
            )
            let sender: InstanceType<typeof FarmStatusSender>
            try {
              sender = new FarmStatusSender({
                client,
                assignmentRefs: refs,
                openSnapshots: source.open,
                signal,
              })
            } catch (error) {
              client.close('runtime-setup-failed')
              // Preserve the cleanup promise in the lifecycle's owned session.
              return {
                start: () => Promise.reject(error),
                close: () => client.close(),
                dispose: (ms) => client.dispose(ms),
              }
            }
            return {
              start: () => sender.start(),
              close: (reason) => sender.close(reason),
              dispose: (ms) => client.dispose(ms),
            }
          },
        }).catch(fail),
      )
    }
    if (offline) {
      // Explicit opt-in only. Absent `pause.control` creates no pause resource.
      const { runPauseControl } = await import('./pause-control.ts')
      tasks.push(
        runPauseControl({
          config,
          credential,
          identity,
          dataDirectory: input.dataDirectory,
          signal,
          freshness: offline.freshness,
          onDiagnostic: pauseDiagnostic,
        }).catch(() => {
          // A pause-path failure never stops read-only telemetry or status.
          pauseDiagnostic({ kind: 'pause-failed' })
        }),
      )
    }
    async function drainLoop() {
      let backoff = config.telemetry.retryMinMs
      let notBefore = 0
      while (!signal.aborted) {
        if (Date.now() >= credential.expires_at) {
          totals.credentialExpired = true
          diagnostic({ kind: 'credential-expired' })
          await untilAbort(signal)
          return
        }
        const wait = notBefore - performance.now()
        if (wait > 0) {
          await pause(
            Math.min(wait, credential.expires_at - Date.now()),
            signal,
          )
          continue
        }
        const attempt = new AbortController()
        const attemptSignal = AbortSignal.any([signal, attempt.signal])
        const timer = setTimeout(
          () => attempt.abort(),
          Math.max(
            1,
            Math.min(
              config.telemetry.timeoutMs,
              credential.expires_at - Date.now(),
            ),
          ),
        )
        let settlement: Promise<unknown> | undefined
        const tracked: TelemetrySender = (body, requestSignal) => {
          if (settlement)
            throw new Error('Overlapping authenticated sender invocation')
          settlement = send(body, requestSignal)
          return settlement
        }
        let result
        try {
          result = await drainTelemetryOnce(
            queue,
            tracked,
            Date.now,
            attemptSignal,
          )
        } finally {
          // Drain may return cancelled before its sender releases the active slot.
          if (settlement) await settlement.catch(() => {})
          clearTimeout(timer)
          attempt.abort()
        }
        if (result.loss) {
          totals.expired += result.loss.expired
          totals.capacity += result.loss.capacity
          if (result.loss.expired || result.loss.capacity)
            diagnostic({
              kind: 'drain-loss',
              expired: result.loss.expired,
              capacity: result.loss.capacity,
            })
        }
        if (
          result.status === 'uncertain' ||
          (result.status === 'retained' &&
            ['busy', 'oversized'].includes(result.reason))
        )
          throw new Error('Telemetry drain requires operator review')
        if (signal.aborted) return
        if (result.status === 'delivered') {
          totals.delivered += result.count
          diagnostic({
            kind: 'delivery',
            status: 'delivered',
            count: result.count,
          })
          backoff = config.telemetry.retryMinMs
          notBefore = 0
        } else if (result.status === 'empty') {
          await pause(config.telemetry.idleMs, signal)
        } else {
          totals.retries++
          diagnostic({ kind: 'delivery', status: 'retained', count: 0 })
          const jittered =
            config.telemetry.retryMinMs +
            Math.floor(
              Math.random() * (backoff - config.telemetry.retryMinMs + 1),
            )
          notBefore = performance.now() + jittered
          backoff = Math.min(config.telemetry.retryMaxMs, backoff * 2)
        }
      }
    }
    tasks.push(
      collectIntoQueue({
        config: config.collection,
        ...(input.onInventory ? { onInventory: input.onInventory } : {}),
        queue,
        signal,
        onDiagnostic: diagnostic,
        ...(snapshots
          ? {
              onRawObservation: snapshots.observe,
              onRawUnavailable: snapshots.invalidate,
            }
          : {}),
      }).catch(fail),
    )
    tasks.push(drainLoop().catch(fail))
    await Promise.all(tasks)
  } catch (error) {
    fail(error)
  } finally {
    controller.abort()
    try {
      await localStatus?.close()
    } catch (error) {
      fail(error)
    }
    snapshots?.close()
    await Promise.all(tasks)
    try {
      queue.close()
    } catch (error) {
      fail(error)
    }
    try {
      input.onDiagnostic({ kind: 'agent-summary', ...totals })
    } catch (error) {
      fail(error)
    }
  }
  if (failure) throw failure.error
}
