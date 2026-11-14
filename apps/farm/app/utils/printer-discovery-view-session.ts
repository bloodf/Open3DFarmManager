import { z } from 'zod'
import type { ConfigurationBrowserSessionInput } from './kobralink-onboarding.ts'
import { parseBoundedJson } from '../../../../packages/farm-protocol/src/json.ts'
import { base64url } from '../../../../packages/farm-protocol/src/encoding.ts'
import { configurationFresh } from '../../../../packages/farm-protocol/src/configuration-common.ts'
import {
  ConfigurationAdmissionChallenge,
  SignedConfigurationCapabilityV1,
  encodeConfigurationAdmissionProof,
  encodeConfigurationCapability,
  signConfigurationAdmissionProof,
  verifyConfigurationCapability,
} from '../../../../packages/farm-protocol/src/configuration-capability.ts'
import {
  ConfigurationRequestFrame,
  configurationFrameTargetHash,
  encodeConfigurationRequest,
} from '../../../../packages/farm-protocol/src/configuration-frames.ts'
import {
  discoveryRequest,
  decodeDiscoveryResult,
} from './webrtc/configuration-discovery-client.ts'
import type { ConfigurationProofsReady } from './webrtc/configuration-browser-peer.ts'
import { ConfigurationBrowserSignallingClient } from './webrtc/configuration-signalling-client.ts'
const ChallengeResponseDto = z.strictObject({
  challenge: ConfigurationAdmissionChallenge,
})
const CapabilityResponseDto = z.strictObject({
  capability: SignedConfigurationCapabilityV1,
})

class ConfigurationHttpError extends Error {
  readonly statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

async function requestConfigurationJson(
  path: string,
  init: {
    method: 'GET' | 'POST'
    signal: AbortSignal
    body?: unknown
    timeoutMs?: number
  },
): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(init.timeoutMs ?? 12_000)
  const signal = AbortSignal.any([init.signal, timeoutSignal])
  const headers: Record<string, string> = { accept: 'application/json' }
  let bodyText: string | undefined
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json'
    bodyText = JSON.stringify(init.body)
  }
  const response = await globalThis.fetch(path, {
    method: init.method,
    headers,
    ...(bodyText !== undefined ? { body: bodyText } : {}),
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    throw new ConfigurationHttpError(
      response.status,
      'Configuration HTTP ' + String(response.status),
    )
  }
  const rawText = await response.text()
  return parseBoundedJson(rawText, {
    maxBytes: 32_768,
    maxDepth: 6,
    maxValues: 128,
    maxStringChars: 16_384,
  })
}

type SignallingClientLike = Pick<
  ConfigurationBrowserSignallingClient,
  'start' | 'sendMessage' | 'close' | 'dispose'
>

function randomNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function openPrinterDiscoverySession(
  input: ConfigurationBrowserSessionInput,
) {
  const requestTimeoutMs = input.requestTimeoutMs ?? 12_000
  let proofs:
    (ConfigurationProofsReady & { advertisedRevision: number }) | null = null
  let terminalReason: string | null = null
  let pendingWaiter: {
    resolve: (
      msg: Extract<
        import('../../../../packages/connector/src/webrtc/configuration-channel.ts').ConnectorChannelMessage,
        { t: 'response' | 'inventory-result' }
      >,
    ) => void
    reject: (err: Error) => void
  } | null = null

  let resolveReady!: (
    value: ConfigurationProofsReady & { advertisedRevision: number },
  ) => void
  let rejectReady!: (err: Error) => void
  const readyPromise = new Promise<
    ConfigurationProofsReady & { advertisedRevision: number }
  >((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A refused start rejects both this and `client.start()`; the caller only
  // ever awaits one of them, so mark this one observed. It is still awaited
  // below and still rejects there with its own reason.
  void readyPromise.catch(() => {})

  const createClient =
    input.createSignalling ??
    ((scope, options) =>
      new ConfigurationBrowserSignallingClient(scope, options))

  const client = createClient(
    {
      farmId: input.farmId,
      agentId: input.agentId,
      keyId: input.keyId,
      accountId: input.accountId,
      connectorFingerprint: input.bootstrap.bootstrap.connectorFingerprint,
      origin: input.bootstrap.bootstrap.origin,
      audience: input.bootstrap.bootstrap.audience,
      publicKey: input.localKey.publicKey,
      privateKey: input.localKey.keyPair.privateKey,
    },
    {
      signal: input.signal,
      onProofsReady(value) {
        proofs = value
        resolveReady(value)
      },
      onMessage(message) {
        const waiter = pendingWaiter
        if (waiter) {
          pendingWaiter = null
          waiter.resolve(message)
        }
      },
      onTerminal(reason) {
        terminalReason = reason
        rejectReady(new Error(reason))
        const waiter = pendingWaiter
        if (waiter) {
          pendingWaiter = null
          waiter.reject(new Error(reason))
        }
      },
    },
  )

  try {
    await client.start()
    await readyPromise
  } catch (error) {
    client.close('closed')
    throw error
  }

  function ensureAlive(signal: AbortSignal): ConfigurationProofsReady {
    if (terminalReason || signal.aborted || input.signal.aborted || !proofs)
      throw new Error(terminalReason ?? 'closed')
    if (
      Date.now() >= proofs.expiresAt ||
      performance.now() >= proofs.deadlineMonoMs
    ) {
      client.close('binding-expired')
      throw new Error('binding-expired')
    }
    return proofs
  }

  async function awaitChannelMessage(signal: AbortSignal) {
    ensureAlive(signal)
    if (pendingWaiter) throw new Error('busy')
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      const w = pendingWaiter
      if (w) {
        pendingWaiter = null
        w.reject(new Error('aborted'))
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await new Promise<
        Extract<
          import('../../../../packages/connector/src/webrtc/configuration-channel.ts').ConnectorChannelMessage,
          { t: 'response' | 'inventory-result' }
        >
      >((resolve, reject) => {
        pendingWaiter = { resolve, reject }
        timer = setTimeout(() => {
          if (pendingWaiter) {
            pendingWaiter = null
            reject(new Error('timeout'))
          }
        }, requestTimeoutMs)
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Sends one channel message and awaits its reply. A send the peer refuses
   * (or that throws) releases the reply slot it registered, so no waiter is
   * left to reject unobserved on a later timeout or terminal.
   */
  async function sendAndAwaitReply(
    message: Parameters<SignallingClientLike['sendMessage']>[0],
    signal: AbortSignal,
    sendFailure: string,
  ) {
    const previous = pendingWaiter
    const reply = awaitChannelMessage(signal)
    const own = pendingWaiter === previous ? null : pendingWaiter
    let sent = false
    try {
      sent = client.sendMessage(message)
    } finally {
      if (!sent) {
        if (own && pendingWaiter === own) {
          pendingWaiter = null
          own.reject(new Error(sendFailure))
        }
        // The caller receives the send failure itself, not this reply.
        void reply.catch(() => {})
      }
    }
    if (!sent) throw new Error(sendFailure)
    return await reply
  }

  async function authorizeAndSendFrame(
    frame: ConfigurationRequestFrame,
    signal: AbortSignal,
    beforeDispatch?: () => void,
    host?: string,
  ) {
    const current = ensureAlive(signal)
    const targetSha256 = await configurationFrameTargetHash(frame)
    const admissionNonce = randomNonce()
    const challengeRaw = await requestConfigurationJson(
      '/api/configuration-authority/challenges',
      {
        method: 'POST',
        signal,
        body: {
          browserProofWire: current.browserProofWire,
          connectorProofWire: current.connectorProofWire,
          admissionNonce,
          action: frame.type,
          operationId: frame.operation_id,
          expectedRevision: frame.expected_revision,
          targetSha256,
        },
      },
    )
    const { challenge } = ChallengeResponseDto.parse(challengeRaw)
    ensureAlive(signal)
    if (
      challenge.farm_id !== input.farmId ||
      challenge.agent_id !== input.agentId ||
      challenge.key_id !== input.keyId ||
      challenge.account_id !== input.accountId ||
      challenge.transport_id !== current.binding.transport_id ||
      challenge.browser_thumbprint !== input.localKey.thumbprint ||
      challenge.origin !== input.bootstrap.bootstrap.origin ||
      challenge.audience !== input.bootstrap.bootstrap.audience ||
      challenge.configuration_binding_sha256 !== current.bindingHash ||
      challenge.admission_nonce !== admissionNonce ||
      challenge.action !== frame.type ||
      challenge.operation_id !== frame.operation_id ||
      challenge.expected_revision !== frame.expected_revision ||
      challenge.target_sha256 !== targetSha256 ||
      !configurationFresh(challenge, Date.now(), 5000)
    ) {
      throw new Error('Invalid configuration admission challenge')
    }
    const admissionProof = await signConfigurationAdmissionProof(
      challenge,
      input.localKey.keyPair.privateKey,
    )
    const admissionProofWire = encodeConfigurationAdmissionProof(admissionProof)
    ensureAlive(signal)
    const capabilityRaw = await requestConfigurationJson(
      '/api/configuration-authority/capabilities',
      {
        method: 'POST',
        signal,
        body: { admissionProofWire },
      },
    )
    const { capability } = CapabilityResponseDto.parse(capabilityRaw)
    if (
      !(await verifyConfigurationCapability(
        capability,
        input.bootstrap.issuerPublicKey,
      )) ||
      capability.capability_id !== challenge.capability_id ||
      capability.operation_id !== frame.operation_id ||
      capability.action !== frame.type ||
      capability.kid !== input.bootstrap.issuer.issuerKid ||
      capability.account_id !== input.accountId ||
      capability.farm_id !== input.farmId ||
      capability.agent_id !== input.agentId ||
      capability.key_id !== input.keyId ||
      capability.transport_id !== current.binding.transport_id ||
      capability.configuration_binding_sha256 !== current.bindingHash ||
      capability.browser_thumbprint !== input.localKey.thumbprint ||
      capability.connector_fingerprint !==
        input.bootstrap.bootstrap.connectorFingerprint ||
      capability.credential_jti !== current.binding.credential_jti ||
      capability.origin !== input.bootstrap.issuer.origin ||
      capability.audience !== input.bootstrap.issuer.audience ||
      capability.admission_nonce !== admissionNonce ||
      capability.expected_revision !== frame.expected_revision ||
      capability.target_sha256 !== targetSha256 ||
      !configurationFresh(capability, Date.now(), 5000)
    ) {
      throw new Error('Invalid configuration capability signature')
    }
    ensureAlive(signal)
    beforeDispatch?.()
    const reply = await sendAndAwaitReply(
      {
        v: 1,
        t: 'discovery',
        ...(host === undefined ? {} : { host }),
        frame: encodeConfigurationRequest(frame),
        capability: encodeConfigurationCapability(capability),
        admission: admissionProofWire,
      },
      signal,
      'send-failed',
    )
    if (reply.t !== 'response')
      throw new Error('Unexpected channel message type')
    const decoded = decodeDiscoveryResult(reply.frame)
    if (decoded.request_id !== frame.request_id)
      throw new Error('Mismatched discovery response')
    return decoded
  }

  return {
    async discover(signal: AbortSignal, host?: string) {
      const frame = await discoveryRequest(
        crypto.randomUUID(),
        crypto.randomUUID(),
        host,
      )
      return authorizeAndSendFrame(frame, signal, undefined, host)
    },
    close() {
      client.close('closed')
    },
  }
}
