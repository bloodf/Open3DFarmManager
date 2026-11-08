import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import {
  telemetryNodeRequest,
  readTelemetryBytes,
} from './telemetry-http-boundary.ts'
import type { PostgresConnectorCredentialRenewal } from '../storage/postgres-connector-credential-renewal.ts'
const challengePath = '/api/connector/credentials/renewal/challenge'
const completePath = '/api/connector/credentials/renewal/complete'
/** New renewal domain; the existing telemetry path/header validator is intentionally not reused. */
export function createCredentialRenewalHttpHandler(
  store: Pick<PostgresConnectorCredentialRenewal, 'allocate' | 'complete'>,
  timeoutMs: number,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid renewal deadline')
  let active = 0
  return async (event: unknown): Promise<{ status: number; body: object }> => {
    if (active >= 32)
      return { status: 429, body: { error: 'Tente novamente.' } }
    active++
    try {
      const req = telemetryNodeRequest(event)
      const target =
        'originalUrl' in req && typeof req.originalUrl === 'string'
          ? req.originalUrl
          : req.url
      if (
        req.method !== 'POST' ||
        (target !== challengePath && target !== completePath) ||
        req.rawHeaders.length > 64
      )
        throw new Error('Invalid renewal request')
      const headers = new Map<string, string>()
      let headerBytes = 0
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]?.toLowerCase(),
          value = req.rawHeaders[i + 1]
        if (!name || value === undefined) throw new Error('Invalid header')
        headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value)
        if (
          headerBytes > 16384 ||
          [
            'cookie',
            'origin',
            'authorization',
            'content-encoding',
            'transfer-encoding',
          ].includes(name)
        )
          throw new Error('Unsupported header')
        if (headers.has(name)) throw new Error('Duplicate header')
        headers.set(name, value)
      }
      const length = headers.get('content-length')
      if (
        headers.get('content-type') !== 'application/json' ||
        !length ||
        !/^[1-9][0-9]*$/.test(length) ||
        Number(length) > 65536
      )
        throw new Error('Invalid content framing')
      const bytes = await readTelemetryBytes(req, timeoutMs)
      if (bytes.byteLength !== Number(length))
        throw new Error('Invalid content length')
      const input = parseBoundedJson(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        { maxBytes: 65536, maxDepth: 8, maxValues: 256, maxStringChars: 8192 },
      )
      const result = await (target === challengePath
        ? store.allocate(input)
        : store.complete(input))
      if (result.kind === 'challenge' || result.kind === 'credential')
        return { status: 200, body: result }
      return {
        status:
          result.kind === 'busy'
            ? 429
            : result.kind === 'unavailable' ||
                result.kind === 'recovery-required'
              ? 503
              : 403,
        body: {
          ...(result.kind === 'recovery-required'
            ? { reason: result.reason }
            : {}),
          error:
            result.kind === 'recovery-required'
              ? 'Recuperação controlada necessária.'
              : 'Não foi possível renovar a credencial.',
        },
      }
    } catch {
      return { status: 400, body: { error: 'Solicitação inválida.' } }
    } finally {
      active--
    }
  }
}
