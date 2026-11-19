import type { Readable } from 'node:stream'
import { IntegrationLimits } from '../integration-auth-limits.ts'
import { BlobStoreError, parseRange, type BlobRange } from './blob-store.ts'

/**
 * `GET /api/connector/library/{sha256}`: a Connector downloads a server-mode
 * library file of its own farm. Authentication, blob lookup, storage and audit
 * are injected so the policy below is testable without a database.
 */

const SHA256 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const DEFAULT_DOWNLOADS_PER_MINUTE = 30

export interface ConnectorIdentity {
  farmId: string
  agentId: string
}
export interface LibraryBlobRecord {
  /** Where the file is kept, as recorded at upload; a mode switch never rewrites it. */
  storageLocation: 'server' | 'connector'
  sizeBytes: number
}
export type DownloadOutcome =
  'served' | 'not-found' | 'kept-on-connector' | 'bad-range' | 'rate-limited'
export interface DownloadAuditEntry {
  farmId: string
  agentId: string
  sha256: string
  outcome: DownloadOutcome
  /** Inclusive byte range served, or null for the whole file / no bytes. */
  range: BlobRange | null
  bytes: number
  occurredAt: number
}
export interface ConnectorLibraryDownloadDeps {
  /**
   * Verifies the Connector credential proof (same proof as telemetry) from the
   * request headers. Null for a bad, expired or revoked credential; the port
   * must read enrollment state at call time so a revocation takes effect at once.
   */
  authenticate(headers: Headers): Promise<ConnectorIdentity | null>
  /** Blob of exactly this farm; null when the farm has no such file (never leak other farms). */
  findBlob(farmId: string, sha256: string): Promise<LibraryBlobRecord | null>
  blobs: {
    read(
      sha256: string,
      range: BlobRange | null,
    ): Promise<{ size: number; range: BlobRange | null; stream: Readable }>
  }
  /** One durable row per authenticated download attempt. Must resolve before bytes are sent. */
  audit(entry: DownloadAuditEntry): Promise<void>
  now?: () => number
  limits?: IntegrationLimits
  perMinute?: number
}
export interface ConnectorLibraryDownloadResponse {
  status: number
  headers: Record<string, string>
  body: Readable | { error: string } | null
}

const text = (
  status: number,
  error: string,
  extra: Record<string, string> = {},
) => ({
  status,
  headers: { 'cache-control': 'no-store', ...extra },
  body: { error },
})

export function createConnectorLibraryDownload(
  deps: ConnectorLibraryDownloadDeps,
) {
  const now = deps.now ?? Date.now
  const limits = deps.limits ?? new IntegrationLimits(now)
  const perMinute = deps.perMinute ?? DEFAULT_DOWNLOADS_PER_MINUTE
  if (!Number.isSafeInteger(perMinute) || perMinute < 1)
    throw new Error('Invalid download rate limit')

  return async function download(
    sha256: string,
    headers: Headers,
  ): Promise<ConnectorLibraryDownloadResponse> {
    if (!SHA256.test(sha256)) return text(400, 'Solicitação inválida.')
    let identity: ConnectorIdentity | null
    try {
      identity = await deps.authenticate(headers)
    } catch {
      return text(503, 'Biblioteca indisponível.')
    }
    if (
      !identity ||
      !UUID.test(identity.farmId) ||
      !UUID.test(identity.agentId)
    )
      return text(403, 'Acesso negado.')

    const record = (
      outcome: DownloadOutcome,
      range: BlobRange | null,
      bytes: number,
    ) =>
      deps.audit({
        farmId: identity.farmId,
        agentId: identity.agentId,
        sha256,
        outcome,
        range,
        bytes,
        occurredAt: now(),
      })
    // Failing to audit fails the download: no bytes without a row.
    const refuse = async (
      outcome: Exclude<DownloadOutcome, 'served'>,
      response: ConnectorLibraryDownloadResponse,
    ) => {
      await record(outcome, null, 0)
      return response
    }

    try {
      const rate = limits.take(
        `library-download:${identity.agentId}`,
        perMinute,
      )
      if (!rate.allowed)
        return refuse(
          'rate-limited',
          text(429, 'Tente novamente em instantes.', {
            'retry-after': String(rate.retry),
          }),
        )

      const blob = await deps.findBlob(identity.farmId, sha256)
      if (!blob)
        return refuse('not-found', text(404, 'Arquivo não encontrado.'))
      if (blob.storageLocation !== 'server')
        return refuse(
          'kept-on-connector',
          text(409, 'O arquivo está guardado no Connector, não no servidor.'),
        )

      let range: BlobRange | null
      try {
        range = parseRange(headers.get('range') ?? undefined, blob.sizeBytes)
      } catch (cause) {
        if (cause instanceof BlobStoreError && cause.code === 'bad-range')
          return refuse(
            'bad-range',
            text(416, 'Intervalo inválido.', {
              'content-range': `bytes */${blob.sizeBytes}`,
            }),
          )
        throw cause
      }

      const read = await deps.blobs.read(sha256, range)
      const served = read.range
      const length = served ? served.end - served.start + 1 : read.size
      try {
        await record('served', served, length)
      } catch (cause) {
        read.stream.destroy()
        throw cause
      }
      return {
        status: served ? 206 : 200,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/octet-stream',
          'content-length': String(length),
          'accept-ranges': 'bytes',
          etag: `"${sha256}"`,
          ...(served
            ? {
                'content-range': `bytes ${served.start}-${served.end}/${read.size}`,
              }
            : {}),
        },
        body: read.stream,
      }
    } catch (cause) {
      if (cause instanceof BlobStoreError && cause.code === 'not-found')
        return text(404, 'Arquivo não encontrado.')
      return text(503, 'Biblioteca indisponível.')
    }
  }
}
export type ConnectorLibraryDownload = ReturnType<
  typeof createConnectorLibraryDownload
>

let active: ConnectorLibraryDownload | undefined
/** Called by trusted Node startup after explicit configuration; absent in Connector-only deployments. */
export function activateConnectorLibraryDownload(
  handler: ConnectorLibraryDownload,
): void {
  if (active) throw new Error('Library download already active')
  active = handler
}
export function connectorLibraryDownload():
  ConnectorLibraryDownload | undefined {
  return active
}
export function deactivateConnectorLibraryDownload(): void {
  active = undefined
}
