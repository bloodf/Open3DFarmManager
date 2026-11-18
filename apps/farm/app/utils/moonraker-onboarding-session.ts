import type {
  ConfigurationBrowserSessionInput,
  ConfigurationSessionOutcome,
} from './kobralink-onboarding.ts'
// The Kobra helper has a closed registration DTO and must remain unchanged.
// Reuse its public types; keep the same config-v1 proof flow for Moonraker.
import { withoutMoonrakerKey } from './moonraker-onboarding.ts'
import { withoutSpoolmanCredentials } from './spoolman-onboarding.ts'
import { z } from 'zod'
import { parseBoundedJson } from '../../../../packages/farm-protocol/src/json.ts'
import { base64url } from '../../../../packages/farm-protocol/src/encoding.ts'
import { BrowserDeviceUuid } from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  CONFIGURATION_PROTOCOL,
  MAX_CONFIGURATION_PROOF_WIRE_BYTES,
  configurationDigest,
  configurationFresh,
  configurationOpaqueId,
} from '../../../../packages/farm-protocol/src/configuration-common.ts'
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
  decodeConfigurationResponse,
  encodeConfigurationRequest,
  type ConfigurationErrorCode,
  type ConfigurationResponseFrame,
} from '../../../../packages/farm-protocol/src/configuration-frames.ts'
import {
  deriveConfigurationAssignmentIdentity,
  decodeConfigurationInventoryAck,
  verifyConfigurationInventoryAck,
} from '../../../../packages/farm-protocol/src/configuration-inventory.ts'
import {
  configurationReceiptHash,
  configurationReceiptMatchesContext,
  decodeConfigurationReceipt,
  encodeConfigurationReceipt,
  verifyConfigurationReceipt,
  type SignedConfigurationReceipt,
} from '../../../../packages/farm-protocol/src/configuration-receipt.ts'
import {
  ConfigurationTarget,
  configurationTargetHash,
} from '../../../../packages/farm-protocol/src/configuration-target.ts'
import type { ConfigurationProofsReady } from './webrtc/configuration-browser-peer.ts'
import { ConfigurationBrowserSignallingClient } from './webrtc/configuration-signalling-client.ts'

export const MoonrakerConfigurationRegistrationResponseDto = z.strictObject({
  assignmentId: BrowserDeviceUuid,
  printerKey: z
    .string()
    .regex(/^(?:moonraker)-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  receiptSha256: configurationDigest,
  status: z.literal('active'),
  replayed: z.boolean(),
  inventoryAckWire: z.string().min(1).max(MAX_CONFIGURATION_PROOF_WIRE_BYTES),
})
export type MoonrakerConfigurationRegistrationResponseDto = z.infer<
  typeof MoonrakerConfigurationRegistrationResponseDto
>

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

/** Outcomes keep the target for display; secrets never stay in browser state. */
function redactTarget(target: ConfigurationTarget): ConfigurationTarget {
  return target.backend === 'moonraker'
    ? (withoutMoonrakerKey(target) as ConfigurationTarget)
    : target.backend === 'spoolman'
      ? (withoutSpoolmanCredentials(target) as ConfigurationTarget)
      : target
}

function randomNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function openMoonrakerConfigurationBrowserSession(
  input: ConfigurationBrowserSessionInput,
) {
  const requestTimeoutMs = input.requestTimeoutMs ?? 12_000
  let proofs:
    (ConfigurationProofsReady & { advertisedRevision: number }) | null = null
  let admittedAuthority: { issuer: string; expiresAt: number } | null = null
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

  await client.start()
  const activeProofs = await readyPromise

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
  ): Promise<ConfigurationResponseFrame> {
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
    admittedAuthority = {
      issuer: capability.issuer,
      expiresAt: capability.expires_at,
    }
    beforeDispatch?.()
    const reply = await sendAndAwaitReply(
      {
        v: 1,
        t: 'request',
        frame: encodeConfigurationRequest(frame),
        capability: encodeConfigurationCapability(capability),
        admission: admissionProofWire,
      },
      signal,
      'send-failed',
    )
    if (reply.t !== 'response')
      throw new Error('Unexpected channel message type')
    const decoded = decodeConfigurationResponse(reply.frame)
    if (
      decoded.request_id !== null &&
      decoded.request_id !== frame.request_id
    ) {
      throw new Error('Mismatched configuration response request_id')
    }
    return decoded
  }

  async function validateReceipt(
    receipt: SignedConfigurationReceipt,
    operationId: string,
    targetSha256: string,
    expectedRevision: number,
    expectedDeviceId?: string,
  ): Promise<string> {
    const current = proofs
    if (!current) throw new Error('Session closed')
    if (
      !(await verifyConfigurationReceipt(receipt, current.connectorPublicKey))
    )
      throw new Error('Invalid Connector receipt signature')
    if (
      !configurationReceiptMatchesContext(receipt, {
        account_id: input.accountId,
        farm_id: input.farmId,
        agent_id: input.agentId,
        operation_id: operationId,
        target_sha256: targetSha256,
        device_id: expectedDeviceId ?? receipt.target.device_id,
        expected_revision: expectedRevision,
      }) ||
      receipt.observed.device_id !== receipt.target.device_id
    ) {
      throw new Error('Receipt context or observed device_id mismatch')
    }
    return await configurationReceiptHash(receipt)
  }

  async function registerAndConfirmInventory(params: {
    operationId: string
    targetSha256: string
    expectedRevision: number
    localCommittedReceipt: SignedConfigurationReceipt
    signal: AbortSignal
  }): Promise<ConfigurationSessionOutcome> {
    const current = ensureAlive(params.signal)
    if (
      params.localCommittedReceipt.phase !== 'local-committed' ||
      params.localCommittedReceipt.committed_revision === null
    ) {
      throw new Error('Expected local-committed receipt')
    }
    const localReceiptSha256 = await validateReceipt(
      params.localCommittedReceipt,
      params.operationId,
      params.targetSha256,
      params.expectedRevision,
    )
    const expectedIdentity = await deriveConfigurationAssignmentIdentity({
      account_id: input.accountId,
      farm_id: input.farmId,
      agent_id: input.agentId,
      bridge_instance_id:
        params.localCommittedReceipt.target.bridge_instance_id,
      device_id: params.localCommittedReceipt.target.device_id,
    })
    const rawReg = await requestConfigurationJson(
      '/api/farms/' + input.farmId + '/configuration-receipts',
      {
        method: 'POST',
        signal: params.signal,
        body: {
          keyId: input.keyId,
          receiptWire: encodeConfigurationReceipt(params.localCommittedReceipt),
        },
      },
    )
    const registration =
      MoonrakerConfigurationRegistrationResponseDto.parse(rawReg)
    if (
      registration.assignmentId !== expectedIdentity.assignment_id ||
      registration.printerKey !== expectedIdentity.printer_key ||
      registration.receiptSha256 !== localReceiptSha256
    ) {
      throw new Error('Server registration identity mismatch')
    }
    if (!admittedAuthority || admittedAuthority.expiresAt <= Date.now())
      throw new Error('Fresh configuration authority required for inventory')
    const decodedAck = decodeConfigurationInventoryAck(
      registration.inventoryAckWire,
    )
    if (
      !(await verifyConfigurationInventoryAck(
        decodedAck,
        input.bootstrap.issuerPublicKey,
        {
          context: {
            account_id: input.accountId,
            farm_id: input.farmId,
            agent_id: input.agentId,
            key_id: input.keyId,
            transport_id: current.binding.transport_id,
            browser_thumbprint: input.localKey.thumbprint,
            connector_fingerprint:
              input.bootstrap.bootstrap.connectorFingerprint,
            credential_jti: current.binding.credential_jti,
            configuration_binding_sha256: current.bindingHash,
            origin: input.bootstrap.bootstrap.origin,
            audience: input.bootstrap.bootstrap.audience,
          },
          kid: input.bootstrap.issuer.issuerKid,
          issuer: admittedAuthority.issuer,
          operation_id: params.operationId,
          committed_receipt_sha256: localReceiptSha256,
          committed_revision: params.localCommittedReceipt.committed_revision,
          assignment_id: expectedIdentity.assignment_id,
          printer_key: expectedIdentity.printer_key,
        },
        Date.now(),
      ))
    ) {
      throw new Error('Invalid server inventory acknowledgement signature')
    }
    ensureAlive(params.signal)
    const invReply = await sendAndAwaitReply(
      {
        v: 1,
        t: 'inventory',
        operation_id: params.operationId,
        local_committed_receipt_sha256: localReceiptSha256,
        committed_revision: params.localCommittedReceipt.committed_revision,
        attestation: registration.inventoryAckWire,
      },
      params.signal,
      'inventory-send-failed',
    )
    if (
      invReply.t !== 'inventory-result' ||
      invReply.operation_id !== params.operationId
    ) {
      throw new Error('Unexpected inventory confirmation response')
    }
    if (!invReply.ok || !invReply.receipt) {
      return {
        kind: 'error',
        code: invReply.reason ?? 'capability-rejected',
      }
    }
    const confirmedReceipt = decodeConfigurationReceipt(invReply.receipt)
    if (
      confirmedReceipt.phase !== 'inventory-confirmed' ||
      confirmedReceipt.prior_receipt_sha256 !== localReceiptSha256 ||
      confirmedReceipt.committed_revision !==
        params.localCommittedReceipt.committed_revision
    ) {
      throw new Error('Invalid inventory-confirmed receipt chain')
    }
    const confirmedSha256 = await validateReceipt(
      confirmedReceipt,
      params.operationId,
      params.targetSha256,
      params.expectedRevision,
      params.localCommittedReceipt.target.device_id,
    )
    return {
      kind: 'inventory-confirmed',
      operationId: params.operationId,
      assignmentId: registration.assignmentId,
      printerKey: registration.printerKey,
      committedRevision: params.localCommittedReceipt.committed_revision,
      replayed: registration.replayed,
      receipt: confirmedReceipt,
      receiptSha256: confirmedSha256,
    }
  }

  async function mapResponseToOutcome(params: {
    response: ConfigurationResponseFrame
    operationId: string
    target: ConfigurationTarget
    targetSha256: string
    expectedRevision: number
    signal: AbortSignal
    completeInventoryOnLocalCommit: boolean
  }): Promise<ConfigurationSessionOutcome> {
    const { response, operationId, target, targetSha256, expectedRevision } =
      params
    if (response.type === 'error') {
      return { kind: 'error', code: response.code }
    }
    if (response.type === 'unknown') {
      return {
        kind: 'unknown',
        operationId,
        reason: response.reason,
      }
    }
    const receipt = response.receipt
    if (response.state === 'recovery-required') {
      return {
        kind: 'recovery-required',
        operationId,
        reason: receipt.recovery_reason,
        receipt,
      }
    }
    const receiptSha256 = await validateReceipt(
      receipt,
      operationId,
      targetSha256,
      expectedRevision,
      target.device_id,
    )
    if (response.state === 'prepared') {
      return {
        kind: 'prepared',
        operationId,
        target: redactTarget(target),
        targetSha256,
        expectedRevision,
        receipt,
        receiptSha256,
      }
    }
    if (response.state === 'local-committed') {
      if (!params.completeInventoryOnLocalCommit) {
        return {
          kind: 'local-committed',
          operationId,
          target: redactTarget(target),
          targetSha256,
          expectedRevision,
          receipt,
          receiptSha256,
        }
      }
      return await registerAndConfirmInventory({
        operationId,
        targetSha256,
        expectedRevision,
        localCommittedReceipt: receipt,
        signal: params.signal,
      })
    }
    const expectedIdentity = await deriveConfigurationAssignmentIdentity({
      account_id: input.accountId,
      farm_id: input.farmId,
      agent_id: input.agentId,
      bridge_instance_id: receipt.target.bridge_instance_id,
      device_id: receipt.target.device_id,
    })
    return {
      kind: 'inventory-confirmed',
      operationId,
      assignmentId: expectedIdentity.assignment_id,
      printerKey: expectedIdentity.printer_key,
      committedRevision: receipt.committed_revision ?? expectedRevision + 1,
      replayed: true,
      receipt,
      receiptSha256,
    }
  }

  return Object.freeze({
    transportId: activeProofs.binding.transport_id,
    advertisedRevision: activeProofs.advertisedRevision,
    expiresAt: activeProofs.expiresAt,
    isAlive: () =>
      !terminalReason &&
      !input.signal.aborted &&
      !!proofs &&
      Date.now() < proofs.expiresAt &&
      performance.now() < proofs.deadlineMonoMs,

    async prepare(params: {
      operationId: string
      target: ConfigurationTarget
      expectedRevision: number
      signal: AbortSignal
      beforeDispatch?: () => void
    }): Promise<ConfigurationSessionOutcome> {
      const targetSha256 = await configurationTargetHash(params.target)
      const frame: ConfigurationRequestFrame = {
        v: 1,
        protocol: CONFIGURATION_PROTOCOL,
        type: 'prepare',
        request_id: crypto.randomUUID(),
        operation_id: params.operationId,
        expected_revision: params.expectedRevision,
        target: params.target,
      }
      const response = await authorizeAndSendFrame(
        frame,
        params.signal,
        params.beforeDispatch,
      )
      return await mapResponseToOutcome({
        response,
        operationId: params.operationId,
        target: params.target,
        targetSha256,
        expectedRevision: params.expectedRevision,
        signal: params.signal,
        completeInventoryOnLocalCommit: false,
      })
    },

    async commit(params: {
      operationId: string
      target: ConfigurationTarget
      targetSha256: string
      preparedReceiptSha256: string
      expectedRevision: number
      signal: AbortSignal
      /**
       * Printer commits finish by registering inventory with the server. A farm
       * setting (Spoolman) has no inventory to register and passes false.
       */
      completeInventory?: boolean
    }): Promise<ConfigurationSessionOutcome> {
      const frame: ConfigurationRequestFrame = {
        v: 1,
        protocol: CONFIGURATION_PROTOCOL,
        type: 'commit',
        request_id: crypto.randomUUID(),
        operation_id: params.operationId,
        expected_revision: params.expectedRevision,
        target_sha256: params.targetSha256,
        prepared_receipt_sha256: params.preparedReceiptSha256,
      }
      const response = await authorizeAndSendFrame(frame, params.signal)
      return await mapResponseToOutcome({
        response,
        operationId: params.operationId,
        target: params.target,
        targetSha256: params.targetSha256,
        expectedRevision: params.expectedRevision,
        signal: params.signal,
        completeInventoryOnLocalCommit: params.completeInventory !== false,
      })
    },

    async reconcile(params: {
      operationId: string
      target: ConfigurationTarget
      targetSha256: string
      expectedRevision: number
      signal: AbortSignal
    }): Promise<ConfigurationSessionOutcome> {
      const frame: ConfigurationRequestFrame = {
        v: 1,
        protocol: CONFIGURATION_PROTOCOL,
        type: 'status',
        request_id: crypto.randomUUID(),
        operation_id: params.operationId,
        expected_revision: params.expectedRevision,
        target_sha256: params.targetSha256,
      }
      const response = await authorizeAndSendFrame(frame, params.signal)
      return await mapResponseToOutcome({
        response,
        operationId: params.operationId,
        target: params.target,
        targetSha256: params.targetSha256,
        expectedRevision: params.expectedRevision,
        signal: params.signal,
        completeInventoryOnLocalCommit: true,
      })
    },

    async cancel(params: {
      operationId: string
      target: ConfigurationTarget
      targetSha256: string
      expectedRevision: number
      signal: AbortSignal
    }): Promise<ConfigurationSessionOutcome> {
      const frame: ConfigurationRequestFrame = {
        v: 1,
        protocol: CONFIGURATION_PROTOCOL,
        type: 'cancel',
        request_id: crypto.randomUUID(),
        operation_id: params.operationId,
        expected_revision: params.expectedRevision,
        target_sha256: params.targetSha256,
      }
      const response = await authorizeAndSendFrame(frame, params.signal)
      return await mapResponseToOutcome({
        response,
        operationId: params.operationId,
        target: params.target,
        targetSha256: params.targetSha256,
        expectedRevision: params.expectedRevision,
        signal: params.signal,
        completeInventoryOnLocalCommit: false,
      })
    },

    close() {
      client.close('closed')
    },
    dispose(timeoutMs = 3000) {
      return client.dispose(timeoutMs)
    },
  })
}
export type MoonrakerConfigurationBrowserSession = Awaited<
  ReturnType<typeof openMoonrakerConfigurationBrowserSession>
>
