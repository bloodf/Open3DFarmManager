import {
  parseBoundedJson,
  TelemetryBatch,
} from '@open3dfarmmanager/farm-protocol'
import { TelemetryProofChallenge } from '../../../farm-protocol/src/telemetry-proof.ts'
import type { ConnectorIdentity } from '../identity/store.ts'
import type { TelemetrySender } from './drain.ts'

/** Explicit trusted configuration; no fallback to the unauthenticated prototype. */
export function createAuthenticatedTelemetrySender(options: {
  endpoint: string
  token: string
  agentId: string
  farmId: string
  audience: string
  timeoutMs: number
  identity: Pick<ConnectorIdentity, 'signTelemetryProof'>
  allowLoopbackHttpForTests?: boolean
}): TelemetrySender {
  const { token, agentId, farmId, audience, timeoutMs, identity } = options
  let origin: string
  try {
    const url = new URL(options.endpoint)
    if (
      options.endpoint !== url.origin + '/api/connector/telemetry' ||
      (url.protocol !== 'https:' &&
        !(
          options.allowLoopbackHttpForTests === true &&
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
        'Bearer ' + token,
      ) ||
      token.length > 8192 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        agentId,
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        farmId,
      ) ||
      !audience ||
      audience.length > 256 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60000 ||
      typeof identity.signTelemetryProof !== 'function'
    )
      throw new Error()
    origin = url.origin
  } catch {
    throw new Error('Invalid telemetry transport configuration')
  }
  const endpoint = origin + '/api/connector/telemetry'
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: 'Bearer ' + token,
    'x-connector-agent': agentId,
    'x-connector-farm': farmId,
  }
  return async (body, callerSignal) => {
    const controller = new AbortController()
    const signal = AbortSignal.any([callerSignal, controller.signal])
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      if (signal.aborted) throw new Error()
      const bytes = new TextEncoder().encode(body)
      TelemetryBatch.parse(
        parseBoundedJson(body, {
          maxBytes: 65536,
          maxDepth: 5,
          maxValues: 2000,
          maxStringChars: 128,
        }),
      )
      async function post(
        path: string,
        requestHeaders: Record<string, string>,
      ): Promise<unknown> {
        const response = await fetch(path, {
          method: 'POST',
          body: bytes,
          signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          headers: requestHeaders,
        })
        if (
          response.status !== 200 ||
          !/^application\/json(?:\s*;|\s*$)/i.test(
            response.headers.get('content-type') ?? '',
          ) ||
          !response.body
        )
          throw new Error()
        const declared = response.headers.get('content-length')
        if (
          declared !== null &&
          (!/^\d+$/.test(declared) || Number(declared) > 8192)
        )
          throw new Error()
        const reader = response.body.getReader()
        try {
          const chunks: Uint8Array[] = []
          let total = 0
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > 8192) throw new Error()
            chunks.push(value)
          }
          if (signal.aborted) throw new Error()
          return parseBoundedJson(
            new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
            {
              maxBytes: 8192,
              maxDepth: 5,
              maxValues: 150,
              maxStringChars: 2048,
            },
          )
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }
      const reply = await post(endpoint + '/challenge', headers)
      if (
        !reply ||
        typeof reply !== 'object' ||
        Array.isArray(reply) ||
        Object.keys(reply).join(',') !== 'challenge' ||
        !('challenge' in reply)
      )
        throw new Error()
      const challenge = TelemetryProofChallenge.parse(reply.challenge)
      if (challenge.agent_id !== agentId || challenge.farm_id !== farmId)
        throw new Error()
      const signature = identity.signTelemetryProof({
        challenge,
        token,
        body: bytes,
        expectedOrigin: origin,
        expectedAudience: audience,
        expectedConnectionId: challenge.connection_id,
        now: Date.now(),
      })
      const encoded = Buffer.from(JSON.stringify(challenge)).toString(
        'base64url',
      )
      const result = await post(endpoint, {
        ...headers,
        'x-telemetry-challenge': encoded,
        'x-telemetry-signature': signature,
      })
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(',') !== 'acceptedEventIds,ok' ||
        !('ok' in result) ||
        result.ok !== true ||
        !('acceptedEventIds' in result) ||
        !Array.isArray(result.acceptedEventIds) ||
        result.acceptedEventIds.length < 1 ||
        result.acceptedEventIds.length > 100 ||
        result.acceptedEventIds.some(
          (id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id),
        )
      )
        throw new Error()
      return result.acceptedEventIds
    } catch {
      throw new Error('Telemetry transport failed')
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
}
