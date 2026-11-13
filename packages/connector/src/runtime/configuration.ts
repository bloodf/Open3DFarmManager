import type { ProvisioningConfig } from '../config/provisioning.ts'
import { runtimeBootstrap } from '../config/provisioning.ts'
import type { ConnectorIdentity } from '../identity/store.ts'
import type { KobraLinkFetch } from '../kobralink/client.ts'
import { createProvisioningEngine } from '../provisioning/engine.ts'
import type { InventoryConfirmationInput } from '../provisioning/authority.ts'
import { readDurableRevision } from '../provisioning/revision.ts'
import {
  ConfigurationConnectorSession,
  type ConfigurationExpectedContext,
  type InventoryOutcome,
} from '../webrtc/configuration-session.ts'
import type { RuntimeActivator } from './configuration-activation.ts'
import { createConfigurationAuthority } from './configuration-authority.ts'
import type { ConfigurationIssuerSource } from './configuration-issuer.ts'

export interface ConfigurationRuntimeOptions {
  identity: ConnectorIdentity
  config: ProvisioningConfig
  issuers: ConfigurationIssuerSource
  activator: RuntimeActivator
  /** Live authenticated configuration signalling; outage refuses writes. */
  serverOnline: () => boolean
  /** Current unexpired credential JTI, or null. */
  credentialJti: () => string | null
  fetch?: KobraLinkFetch
  clock?: () => number
  onDiagnostic?: (event: Readonly<Record<string, unknown>>) => void
}

const MAX_SEEN = 256
const MAX_SESSIONS = 4

/**
 * Configuration-provisioning runtime of one paired Connector (zero printers
 * allowed). Wires authenticated config-v1 sessions to the durable engine and
 * reloads the existing validated telemetry runtime after a local commit.
 * Restart reuses the durable journal; a lost acknowledgement is answered from
 * it and never repeats printer creation.
 */
export function createConfigurationRuntime(
  options: ConfigurationRuntimeOptions,
) {
  const { config, identity } = options
  const clock = options.clock ?? Date.now
  const report = (event: Readonly<Record<string, unknown>>) => {
    try {
      options.onDiagnostic?.(event)
    } catch {
      /* Diagnostics are observational only. */
    }
  }
  const authority = createConfigurationAuthority({
    farm_id: config.farm_id,
    agent_id: config.agent_id,
    clock,
    serverOnline: options.serverOnline,
    credentialJti: options.credentialJti,
    issuers: options.issuers,
  })
  const engine = createProvisioningEngine({
    stateDirectory: config.stateDirectory,
    runtime: {
      runtimeConfigPath: config.runtimeConfigPath,
      agent_id: config.agent_id,
      farm_id: config.farm_id,
      bootstrap: runtimeBootstrap(config),
    },
    connector: identity.configurationReceiptSigner(),
    authority: authority.adapter,
    managedBridge: config.managedBridge,
    printerNetworks: config.printerNetworks,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    clock,
  })
  const seen: string[] = []
  const sessions = new Set<ConfigurationConnectorSession>()
  let stopped = false

  function claimFresh(transportId: string, nonce: string): boolean {
    if (seen.includes(transportId) || seen.includes(nonce)) return false
    seen.push(transportId, nonce)
    if (seen.length > MAX_SEEN) seen.splice(0, seen.length - MAX_SEEN)
    return true
  }

  /**
   * Starts only confirmed assignments. A new local commit stays out of the
   * collection snapshot until its authenticated inventory acknowledgement is
   * durable; if the pending set cannot be read, nothing is (re)started.
   */
  async function activate(reason: string): Promise<void> {
    try {
      const result = await options.activator.reload(
        await engine.unconfirmedAssignmentIds(),
      )
      report({ kind: 'configuration-activation', reason, result })
    } catch {
      report({ kind: 'configuration-activation', reason, result: 'failed' })
    }
  }

  const handler = Object.freeze({
    async handle(request: { frame: unknown; context: unknown }) {
      const response = await engine.handle(request)
      if (
        response.type === 'result' &&
        (response.state === 'local-committed' ||
          response.state === 'inventory-confirmed')
      )
        await activate('local-commit')
      return response
    },
    async confirmInventory(
      request: InventoryConfirmationInput,
    ): Promise<InventoryOutcome> {
      try {
        const outcome = await engine.confirmInventory(request)
        if (outcome.ok) await activate('inventory-confirmed')
        return outcome
      } catch {
        return { ok: false, reason: 'busy' }
      }
    },
  })

  return Object.freeze({
    engine,
    authority,
    /** Activates an already committed runtime (restart) and reports pending acks. */
    async start(): Promise<{ pendingInventory: number }> {
      await activate('startup')
      const pending = await engine.pendingInventoryConfirmations()
      return { pendingInventory: pending.length }
    },
    /** Durable committed revision advertised to the server; null if unreadable. */
    revision(): number | null {
      return readDurableRevision(config.stateDirectory)
    },
    /** One session per authenticated `config.context-request`. */
    openSession(input: {
      expected: ConfigurationExpectedContext
      send: (wire: string) => void
      onTerminal?: (reason: string) => void
      authDeadlineMs?: number
    }): ConfigurationConnectorSession {
      if (stopped || sessions.size >= MAX_SESSIONS)
        throw new Error('Configuration session unavailable')
      const session = new ConfigurationConnectorSession({
        identity,
        expected: input.expected,
        issuers: options.issuers,
        authority,
        handler,
        send: input.send,
        claimFresh,
        clock,
        ...(input.authDeadlineMs !== undefined
          ? { authDeadlineMs: input.authDeadlineMs }
          : {}),
        onTerminal: (reason) => {
          sessions.delete(session)
          report({ kind: 'configuration-session', terminal: reason })
          input.onTerminal?.(reason)
        },
      })
      sessions.add(session)
      return session
    },
    /** Server link lost or credential replaced: nothing remains current. */
    revokeAll(): void {
      authority.revokeAll()
      for (const session of [...sessions]) session.close('authority-revoked')
    },
    async shutdown(): Promise<void> {
      stopped = true
      authority.revokeAll()
      const closing = [...sessions].map((session) => {
        session.close('shutdown')
        return session.closed
      })
      await Promise.allSettled(closing)
      await options.activator.stop()
    },
    diagnostics() {
      return Object.freeze({
        sessions: sessions.size,
        runtimeActive: options.activator.active,
        ...authority.diagnostics(),
      })
    },
  })
}
export type ConfigurationRuntime = ReturnType<typeof createConfigurationRuntime>
