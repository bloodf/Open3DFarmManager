import type {
  ConfigurationSignallingCoordinator,
  ConfigurationSignallingEndpoint,
  ConfigurationSignallingHandle,
  ConfigurationSignallingTimers,
} from './configuration-signalling-coordinator.ts'
import {
  decodeConfigurationSignallingClientFrame,
  encodeConfigurationSignallingServerFrame,
} from './configuration-signalling-wire.ts'

export interface ConfigurationSocketPort {
  send(wire: string): void
  close(): void
}
type State =
  | { kind: 'browser.begin' }
  | { kind: 'connector.begin'; attempts: number }
  | { kind: 'connector.proof'; handle: ConfigurationSignallingHandle }
  | { kind: 'connector.ready'; handle: ConfigurationSignallingHandle }
  | { kind: 'browser.relay'; handle: ConfigurationSignallingHandle }
  | { kind: 'closed' }

/**
 * One authenticated socket of the config-v1 signalling endpoints. The browser
 * session ID comes from upgrade cookie unsealing, never from a frame. Frames
 * must be processed one at a time; any unexpected frame closes the socket.
 */
export function createConfigurationSocketSession(input: {
  role: 'browser' | 'connector'
  /** Required for the browser role. */
  sessionRecordId?: string | undefined
  coordinator: Pick<
    ConfigurationSignallingCoordinator,
    | 'open'
    | 'connectorBegin'
    | 'connectorProve'
    | 'advertise'
    | 'relay'
    | 'closeHandle'
  >
  port: ConfigurationSocketPort
  timers: ConfigurationSignallingTimers
}) {
  const { coordinator, port, timers } = input
  let state: State =
    input.role === 'browser'
      ? { kind: 'browser.begin' }
      : { kind: 'connector.begin', attempts: 0 }
  // Bounds the unauthenticated phase; the coordinator owns later deadlines.
  let cancelAdmission = timers.after(8000, () => close())

  function close(): void {
    const previous = state
    if (previous.kind === 'closed') return
    state = { kind: 'closed' }
    cancelAdmission()
    if ('handle' in previous) coordinator.closeHandle(previous.handle)
    try {
      port.close()
    } catch {}
  }
  const endpoint: ConfigurationSignallingEndpoint = Object.freeze({
    purpose: 'configuration' as const,
    armDeadline: (remainingMs: number, expired: () => void) =>
      timers.after(remainingMs, expired),
    send: (wire: string) => {
      if (state.kind !== 'closed') port.send(wire)
    },
    close,
  })

  async function process(wire: string): Promise<void> {
    const frame = decodeConfigurationSignallingClientFrame(wire)
    const current = state
    switch (current.kind) {
      case 'browser.begin': {
        if (frame.t !== 'config.begin' || !input.sessionRecordId)
          throw new Error('Expected config.begin')
        const opened = await coordinator.open(
          {
            sessionRecordId: input.sessionRecordId,
            farmId: frame.farm_id,
            agentId: frame.agent_id,
            keyId: frame.key_id,
          },
          endpoint,
        )
        if (!opened || state !== current) {
          if (opened) coordinator.closeHandle(opened.handle)
          throw new Error('Configuration signalling denied')
        }
        cancelAdmission()
        state = { kind: 'browser.relay', handle: opened.handle }
        port.send(opened.readyWire)
        return
      }
      case 'connector.begin': {
        if (frame.t !== 'config.connector-begin')
          throw new Error('Expected config.connector-begin')
        const begun = await coordinator.connectorBegin(
          {
            farmId: frame.farm_id,
            agentId: frame.agent_id,
            jti: frame.jti,
            token: frame.token,
          },
          endpoint,
        )
        if (!begun || state !== current) {
          if (begun?.kind === 'challenge') coordinator.closeHandle(begun.handle)
          throw new Error('Connector denied')
        }
        if (begun.kind === 'busy') {
          if (current.attempts >= 2) throw new Error('Connector busy')
          state = { kind: 'connector.begin', attempts: current.attempts + 1 }
          port.send(
            encodeConfigurationSignallingServerFrame({
              v: 1,
              t: 'config.retry',
              retry_after_ms: begun.retryAfterMs,
            }),
          )
          return
        }
        state = { kind: 'connector.proof', handle: begun.handle }
        port.send(
          encodeConfigurationSignallingServerFrame({
            v: 1,
            t: 'config.connector-challenge',
            challenge: begun.challenge,
          }),
        )
        return
      }
      case 'connector.proof': {
        if (frame.t !== 'config.connector-proof')
          throw new Error('Expected config.connector-proof')
        const ready = await coordinator.connectorProve(
          current.handle,
          frame.signature,
        )
        if (!ready || state !== current) throw new Error('Proof denied')
        cancelAdmission()
        state = { kind: 'connector.ready', handle: current.handle }
        port.send(
          encodeConfigurationSignallingServerFrame({
            v: 1,
            t: 'config.connector-ready',
            inbox_id: ready.inboxId,
            issued_at: ready.issuedAt,
            expires_at: ready.expiresAt,
          }),
        )
        return
      }
      case 'connector.ready':
        if (frame.t === 'config.advertise') {
          if (
            !coordinator.advertise(current.handle, {
              revision: frame.revision,
            })
          )
            throw new Error('Advertisement denied')
          return
        }
      // A ready Connector otherwise only relays rtc.* frames.
      // falls through
      case 'browser.relay':
        if (!frame.t.startsWith('rtc.')) throw new Error('Expected rtc frame')
        // A refused relay already closed its transport; the Connector inbox stays open.
        if (
          !(await coordinator.relay(current.handle, wire)) &&
          current.kind === 'browser.relay'
        )
          throw new Error('Relay refused')
        return
      case 'closed':
        return
    }
  }
  return Object.freeze({
    async receive(wire: string): Promise<void> {
      try {
        await process(wire)
      } catch {
        close()
      }
    },
    close,
    get closed() {
      return state.kind === 'closed'
    },
  })
}
export type ConfigurationSocketSession = ReturnType<
  typeof createConfigurationSocketSession
>
