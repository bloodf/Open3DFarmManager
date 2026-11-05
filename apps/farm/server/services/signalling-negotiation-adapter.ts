import { encodeSignallingServerFrame } from '../../../../packages/farm-protocol/src/signalling-socket.ts'
import { encodePauseSignallingServerFrame } from '../../../../packages/farm-protocol/src/pause-signalling.ts'
import type { CredentialProofChallenge } from '../../../../packages/farm-protocol/src/credential-proof.ts'
import type {
  SignallingCoordinator,
  SignallingHandle,
  SignallingScope,
} from './signalling-coordinator.ts'
import type {
  PauseSignallingCoordinator,
  PauseSignallingHandle,
} from './pause-signalling-coordinator.ts'
import type { PauseNegotiationScope } from '../storage/postgres-pause-negotiation.ts'

export type SignallingMode = 'read-only' | 'pause'
export interface SignallingMetadataPort {
  armDeadline(ms: number, expired: () => void): () => void
  send(wire: string): void
  close(): void
}
type ReadOnlyDescription = NonNullable<
  ReturnType<SignallingCoordinator['describe']>
>
export type NegotiationDescription =
  | (Readonly<ReadOnlyDescription> & { readonly mode: 'read-only' })
  | (NonNullable<ReturnType<PauseSignallingCoordinator['describe']>> & {
      readonly mode: 'pause'
    })
export interface NegotiationPeer {
  prove(signature: string): Promise<boolean>
  describe(): NegotiationDescription | null
  relay(wire: string): Promise<boolean>
  close(): void
}
export interface NegotiationContext extends NegotiationPeer {
  attach(
    port: SignallingMetadataPort,
    token: string,
    lifetime: { expiresAt: number; monotonicDeadline: number },
  ): Promise<
    | {
        kind: 'challenge'
        peer: NegotiationPeer
        challenge: CredentialProofChallenge
      }
    | { kind: 'busy'; retryAfterMs: number }
    | null
  >
}

/** Handles stay inside their owning coordinator closure; this port grants no authority. */
export async function openReadOnlyNegotiation(
  coordinator: SignallingCoordinator,
  scope: SignallingScope,
  port: SignallingMetadataPort,
) {
  const endpoint = (target: SignallingMetadataPort) => ({
    ...target,
    bindReadOnly: (
      binding: Parameters<
        Parameters<SignallingCoordinator['open']>[1]['bindReadOnly']
      >[0],
    ) =>
      target.send(
        encodeSignallingServerFrame({ v: 1, t: 'rtc.binding', binding }),
      ),
  })
  const opened = await coordinator.open(scope, endpoint(port))
  if (!opened) return null
  const peer = (handle: SignallingHandle): NegotiationPeer =>
    Object.freeze({
      prove: (signature: string) => coordinator.prove(handle, signature),
      describe: () => {
        const value = coordinator.describe(handle)
        return value
          ? Object.freeze({ ...value, mode: 'read-only' as const })
          : null
      },
      relay: (wire: string) => coordinator.receiveAndWait(handle, wire),
      close: () => coordinator.disconnect(handle),
    })
  const context: NegotiationContext = Object.freeze({
    ...peer(opened.handle),
    async attach(
      ...[target, token, lifetime]: Parameters<NegotiationContext['attach']>
    ) {
      const result = await coordinator.attachConnector(
        opened.handle,
        endpoint(target),
        token,
        lifetime,
      )
      return result?.kind === 'challenge'
        ? {
            kind: 'challenge' as const,
            peer: peer(result.handle),
            challenge: result.challenge,
          }
        : result
    },
  })
  return {
    context,
    challengeWire: encodeSignallingServerFrame({
      v: 1,
      t: 'browser.challenge',
      challenge: opened.challenge,
    }),
  }
}

export async function openPauseNegotiation(
  coordinator: PauseSignallingCoordinator,
  scope: PauseNegotiationScope,
  port: SignallingMetadataPort,
) {
  const endpoint = (target: SignallingMetadataPort) => ({
    ...target,
    purpose: 'pause' as const,
    bindControl: (
      binding: Parameters<
        Parameters<PauseSignallingCoordinator['open']>[1]['bindControl']
      >[0],
    ) =>
      target.send(
        encodePauseSignallingServerFrame({ v: 1, t: 'pause.binding', binding }),
      ),
  })
  const opened = await coordinator.open(scope, endpoint(port))
  if (!opened) return null
  const peer = (handle: PauseSignallingHandle): NegotiationPeer =>
    Object.freeze({
      prove: (signature: string) => coordinator.prove(handle, signature),
      describe: () => {
        const value = coordinator.describe(handle)
        return value
          ? Object.freeze({ ...value, mode: 'pause' as const })
          : null
      },
      relay: (wire: string) => coordinator.relay(handle, wire),
      close: () => coordinator.closeHandle(handle),
    })
  const context: NegotiationContext = Object.freeze({
    ...peer(opened.handle),
    async attach(
      ...[target, token, lifetime]: Parameters<NegotiationContext['attach']>
    ) {
      const result = await coordinator.attachConnector(
        opened.handle,
        endpoint(target),
        token,
        lifetime,
      )
      return result?.kind === 'challenge'
        ? {
            kind: 'challenge' as const,
            peer: peer(result.handle),
            challenge: result.challenge,
          }
        : result
    },
  })
  return {
    context,
    challengeWire: encodePauseSignallingServerFrame({
      v: 1,
      t: 'pause.challenge',
      challenge: opened.challenge,
    }),
  }
}
