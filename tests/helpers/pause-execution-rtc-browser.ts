import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import {
  BrowserDeviceProofChallenge,
  signBrowserDeviceProof,
  validateBrowserDevicePublicKey,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { BROWSER_DEVICE_HTTP_AUDIENCE } from '../../packages/farm-protocol/src/browser-device-http.ts'
import { PauseBrowserSignallingClient } from '../../apps/farm/app/utils/webrtc/pause-signalling-client.ts'
import { createPauseCommandClient } from '../../apps/farm/app/utils/webrtc/pause-command-client.ts'
import { createPauseCommandIssuer } from '../../apps/farm/app/utils/webrtc/pause-command-issuer.ts'
import { decodeCommandV2 } from '../../packages/farm-protocol/src/command-v2.ts'
import type {
  PauseCommandOutcome,
  PauseProofsReady,
  PausePhaseMessage,
  PauseCommandMessage,
} from '../../packages/connector/src/webrtc/pause-control-session.ts'

export type PauseExecutionBrowserScope = Readonly<{
  accountId: string
  farmId: string
  origin: string
  audience: string
  issuer: string
  kid: string
  publicKeySpki: string
}>

export type PauseExecutionCommandReceipt = Readonly<{
  commandId: string
  transportId: string
  outcome: PauseCommandOutcome
}>

export async function createPauseExecutionRtcBrowserActor(
  scope: PauseExecutionBrowserScope,
) {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  // Only the public coordinates; the exported JWK also carries key_ops and ext.
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const identity = await validateBrowserDevicePublicKey({ kty, crv, x, y })

  const abort = new AbortController()
  let enrolled = false
  let terminal = false
  let failed = false
  let client: PauseBrowserSignallingClient | undefined
  let commandClient: ReturnType<typeof createPauseCommandClient> | undefined
  let proofs: PauseProofsReady | undefined
  let lastOutcome: PauseCommandOutcome | null = null
  let lastSentCommand:
    | {
        commandId: string
        transportId: string
      }
    | undefined
  let commandHttpRequests = 0
  let lastWire: string | undefined
  let lastReceipt: PauseExecutionCommandReceipt | undefined

  const stop = () => {
    terminal = true
    abort.abort()
    commandClient?.abort()
    client?.close()
  }

  return Object.freeze({
    publicJwk: Object.freeze({ ...identity.publicKey }),

    async signEnrollment(value: unknown) {
      const c = BrowserDeviceProofChallenge.parse(value)
      const now = Date.now()
      if (
        terminal ||
        enrolled ||
        c.purpose !== 'enroll' ||
        c.account_id !== scope.accountId ||
        c.farm_id !== scope.farmId ||
        c.origin !== scope.origin ||
        c.audience !== BROWSER_DEVICE_HTTP_AUDIENCE ||
        c.thumbprint !== identity.thumbprint ||
        now < c.issued_at ||
        now >= c.expires_at
      ) {
        throw Error('Pause execution fixture enrollment mismatch')
      }
      enrolled = true
      const signature = await signBrowserDeviceProof(c, pair.privateKey)
      if (terminal || Date.now() >= c.expires_at) {
        throw Error('Pause execution fixture enrollment expired')
      }
      return signature
    },

    start(value: {
      browserKeyId: string
      agentId: string
      assignmentId: string
    }) {
      if (client || terminal || !enrolled) {
        throw Error('Pause execution browser start unavailable')
      }

      const httpIssuer = createPauseCommandIssuer({
        fetch: (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
            scope.origin,
          )
          if (
            ![
              '/api/pause-authority/challenges',
              '/api/pause-authority/capabilities',
            ].includes(url.pathname)
          ) {
            commandHttpRequests++
          }
          return window.fetch(input, init)
        },
        currentOrigin: scope.origin,
      })

      commandClient = createPauseCommandClient({
        privateKey: pair.privateKey,
        issuer: httpIssuer,
        transport: {
          sendPhase: (message: PausePhaseMessage) =>
            client?.sendPhase(message) ?? false,
          sendCommand: (message: PauseCommandMessage) => {
            try {
              const decoded = decodeCommandV2(message.wire)
              lastWire = message.wire
              lastSentCommand = {
                commandId: decoded.cmd_id,
                transportId: decoded.transport_id,
              }
            } catch {
              // Captured on best effort
            }
            return client?.sendCommand(message) ?? false
          },
        },
        onOutcome: (outcome) => {
          lastOutcome = outcome
          if (lastSentCommand) {
            lastReceipt = Object.freeze({
              commandId: lastSentCommand.commandId,
              transportId: lastSentCommand.transportId,
              outcome,
            })
          }
        },
        signal: abort.signal,
      })

      client = new PauseBrowserSignallingClient(
        {
          accountId: scope.accountId,
          farmId: scope.farmId,
          origin: scope.origin,
          audience: scope.audience,
          keyId: value.browserKeyId,
          agentId: value.agentId,
          assignmentId: value.assignmentId,
          publicKey: identity.publicKey,
          privateKey: pair.privateKey,
        },
        {
          signal: abort.signal,
          onProofsReady: (ready) => {
            if (proofs) throw Error('Repeated proofs')
            proofs = ready
            commandClient?.proofsReady(ready)
          },
          onPhase: (frame) => {
            commandClient?.phase(frame)
          },
          onData: (frame) => {
            commandClient?.data(frame)
          },
          onTerminal: () => {
            terminal = true
            commandClient?.abort()
            abort.abort()
          },
        },
      )

      void client.start().catch(() => {
        failed = true
        stop()
      })
    },

    async pause(): Promise<PauseCommandOutcome> {
      if (!commandClient || terminal || failed) return 'rejected'
      return await commandClient.pause()
    },

    replay(): boolean {
      if (!client || !lastWire || terminal || failed) return false
      return client.sendCommand({ t: 'control.command', wire: lastWire })
    },

    observe() {
      return {
        terminal,
        failed,
        commandHttpRequests,
        proofsReady: !!proofs,
        admitted: commandClient?.state.admitted ?? false,
        commandSent: commandClient?.state.commandSent ?? false,
        outcome: lastOutcome,
        commandReceipt: lastReceipt ?? null,
        diagnostics: client?.diagnostics(),
      }
    },

    async dispose() {
      stop()
      const results = await Promise.allSettled([
        commandClient?.settled,
        client?.dispose(3000),
      ])
      if (results.some((r) => r.status === 'rejected')) {
        throw Error('Pause execution browser cleanup incomplete')
      }
    },
  })
}
