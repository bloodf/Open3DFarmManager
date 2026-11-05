import { randomUUID } from 'node:crypto'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { TelemetryProofChallenge } from '../../../../packages/farm-protocol/src/telemetry-proof.ts'
import type { PostgresConnectorCredentialAcceptance } from '../storage/postgres-connector-credential-acceptance.ts'
import {
  inspectTelemetryRequest,
  readTelemetryBytes,
  telemetryNodeRequest,
} from './telemetry-http-boundary.ts'

type Store = Pick<
  PostgresConnectorCredentialAcceptance,
  'issueTelemetryChallenge' | 'commitTelemetryWithProof'
>
export interface TelemetryHttpResponse {
  status: number
  body: object
}
const invalid = (): TelemetryHttpResponse => ({
  status: 400,
  body: { error: 'Solicitação inválida.' },
})
/** Disabled until a trusted bootstrap provides the dedicated telemetry store. */
export function createTelemetryHttpHandler(store: Store, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid telemetry deadline')
  let active = 0
  return async (event: unknown): Promise<TelemetryHttpResponse> => {
    if (active >= 32)
      return { status: 429, body: { error: 'Tente novamente.' } }
    active++
    try {
      const req = telemetryNodeRequest(event)
      const headers = inspectTelemetryRequest(req)
      const authorization = headers.get('authorization')
      const agentId = headers.get('x-connector-agent')
      const farmId = headers.get('x-connector-farm')
      if (
        !authorization ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          authorization,
        ) ||
        authorization.length > 8199 ||
        !agentId ||
        !farmId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          agentId,
        ) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          farmId,
        )
      )
        return invalid()
      const target =
        'originalUrl' in req && typeof req.originalUrl === 'string'
          ? req.originalUrl
          : req.url
      const token = authorization.slice(7)
      let input: {
        token: string
        agentId: string
        farmId: string
        connectionId: string
        challenge?: unknown
        signature?: string
      }
      if (target === '/api/connector/telemetry/challenge') {
        if (
          headers.has('x-telemetry-challenge') ||
          headers.has('x-telemetry-signature')
        )
          return invalid()
        input = { token, agentId, farmId, connectionId: randomUUID() }
      } else {
        const encoded = headers.get('x-telemetry-challenge'),
          signature = headers.get('x-telemetry-signature')
        if (
          !encoded ||
          encoded.length > 4096 ||
          !/^[A-Za-z0-9_-]+$/.test(encoded) ||
          !signature ||
          !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(signature)
        )
          return invalid()
        const raw = Buffer.from(encoded, 'base64url')
        if (raw.toString('base64url') !== encoded) return invalid()
        const challenge = TelemetryProofChallenge.parse(
          parseBoundedJson(
            new TextDecoder('utf-8', { fatal: true }).decode(raw),
            {
              maxBytes: 3072,
              maxDepth: 3,
              maxValues: 32,
              maxStringChars: 2048,
            },
          ),
        )
        input = {
          token,
          agentId,
          farmId,
          connectionId: challenge.connection_id,
          challenge,
          signature,
        }
      }
      const body = await readTelemetryBytes(req, timeoutMs)
      const decision =
        target === '/api/connector/telemetry/challenge'
          ? await store.issueTelemetryChallenge(input, body)
          : await store.commitTelemetryWithProof(input, body)
      if (!decision.ok) {
        const status =
          decision.reason === 'busy'
            ? 429
            : decision.reason === 'storage-unavailable'
              ? 503
              : decision.reason === 'conflict'
                ? 409
                : decision.reason === 'invalid-input'
                  ? 400
                  : 403
        return {
          status,
          body: { error: 'Não foi possível processar a telemetria.' },
        }
      }
      if (
        target === '/api/connector/telemetry/challenge' &&
        decision.kind === 'challenge'
      )
        return { status: 200, body: { challenge: decision.challenge } }
      if (
        target === '/api/connector/telemetry' &&
        decision.kind === 'telemetry-committed'
      )
        return {
          status: 200,
          body: { ok: true, acceptedEventIds: decision.acceptedEventIds },
        }
      return { status: 503, body: { error: 'Telemetria indisponível.' } }
    } catch {
      return invalid()
    } finally {
      active--
    }
  }
}
