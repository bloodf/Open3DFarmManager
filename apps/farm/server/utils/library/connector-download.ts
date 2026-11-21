import { createHash, createPublicKey, verify } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { Sql } from 'postgres'
import { verifyConnectorCredential } from '../connector-credentials.ts'
import { IntegrationLimits } from '../integration-auth-limits.ts'
import { BlobStoreError, parseRange, type BlobRange } from './blob-store.ts'
import {
  CONNECTOR_LIBRARY_PROOF_HEADER,
  CONNECTOR_LIBRARY_PROOF_TTL_MS,
  CONNECTOR_LIBRARY_SIGNATURE,
  CONNECTOR_LIBRARY_SIGNATURE_HEADER,
  ConnectorLibraryProof,
  connectorLibraryProofPayload,
} from '../../../../../packages/farm-protocol/src/connector-library-proof.ts'

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

/** Same credential policy the telemetry endpoint accepts; the keys are the issuer's public keys. */
export interface ConnectorCredentialPolicy {
  issuer: string
  audience: string
  ttlSeconds: number
  publicKeys: ReadonlyMap<string, CryptoKey>
}
export interface ConnectorEnrollmentReader {
  /** Current enrollment of this agent in this farm, read at call time; null when none. */
  find(
    farmId: string,
    agentId: string,
  ): Promise<{ status: string; publicKeySpki: string } | null>
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
/** Tolerated clock difference between the Connector and the server. */
const PROOF_SKEW_MS = 30_000
const MAX_SEEN_PROOFS = 16_384

/**
 * Nonces of accepted proofs, kept until they expire, so a captured proof is
 * never accepted twice (shared by download and relay in this process).
 */
const seenProofs = new Map<string, number>()
function rememberProof(nonce: string, expiresAt: number, at: number): boolean {
  if (seenProofs.has(nonce)) return false
  if (seenProofs.size >= MAX_SEEN_PROOFS)
    for (const [key, until] of seenProofs)
      if (until + PROOF_SKEW_MS <= at) seenProofs.delete(key)
  if (seenProofs.size >= MAX_SEEN_PROOFS) return false
  seenProofs.set(nonce, expiresAt)
  return true
}

/** Verifies the per-request proof of possession signed by the enrolled key. */
function verifyLibraryProof(input: {
  headers: Headers
  token: string
  agentId: string
  farmId: string
  publicKeySpki: string
  at: number
}): boolean {
  const encoded = input.headers.get(CONNECTOR_LIBRARY_PROOF_HEADER) ?? ''
  const signature = input.headers.get(CONNECTOR_LIBRARY_SIGNATURE_HEADER) ?? ''
  if (
    !encoded ||
    encoded.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !CONNECTOR_LIBRARY_SIGNATURE.test(signature)
  )
    return false
  const raw = Buffer.from(encoded, 'base64url')
  if (raw.toString('base64url') !== encoded) return false
  const parsed = ConnectorLibraryProof.safeParse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
  )
  if (!parsed.success) return false
  const proof = parsed.data
  if (
    proof.agent_id !== input.agentId ||
    proof.farm_id !== input.farmId ||
    proof.token_hash !==
      createHash('sha256').update(input.token).digest('base64url') ||
    proof.issued_at > input.at + PROOF_SKEW_MS ||
    proof.expires_at <= input.at ||
    proof.expires_at > input.at + CONNECTOR_LIBRARY_PROOF_TTL_MS + PROOF_SKEW_MS
  )
    return false
  const valid = verify(
    null,
    connectorLibraryProofPayload(proof),
    createPublicKey({
      key: Buffer.from(input.publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    }),
    Buffer.from(signature, 'base64url'),
  )
  return valid && rememberProof(proof.nonce, proof.expires_at, input.at)
}

/**
 * Authenticates a download from the Connector credential (`Authorization:
 * Bearer`, `x-connector-agent`, `x-connector-farm`, the headers telemetry uses)
 * plus a fresh proof of possession (`x-connector-proof` and
 * `x-connector-proof-signature`) signed by the enrolled Connector key, so a
 * leaked bearer token alone is refused (#580). The signature, claims and key
 * binding are verified, and the enrollment must be approved right now, so a
 * revoked Connector is refused at once. Anything else is null; a storage
 * failure throws and answers 503.
 */
export function createConnectorLibraryAuthenticator(input: {
  credentials: ConnectorCredentialPolicy
  enrollments: ConnectorEnrollmentReader
  now?: () => number
}): ConnectorLibraryDownloadDeps['authenticate'] {
  const now = input.now ?? Date.now
  return async (headers) => {
    const authorization = headers.get('authorization') ?? ''
    const agentId = headers.get('x-connector-agent') ?? ''
    const farmId = headers.get('x-connector-farm') ?? ''
    const token = BEARER.exec(authorization)?.[1]
    if (
      !token ||
      authorization.length > 8199 ||
      !UUID.test(agentId) ||
      !UUID.test(farmId) ||
      !headers.get(CONNECTOR_LIBRARY_PROOF_HEADER) ||
      !headers.get(CONNECTOR_LIBRARY_SIGNATURE_HEADER)
    )
      return null
    const enrollment = await input.enrollments.find(farmId, agentId)
    if (!enrollment || enrollment.status !== 'approved') return null
    try {
      const at = now()
      await verifyConnectorCredential({
        ...input.credentials,
        token,
        agentId,
        farmId,
        publicKeySpki: enrollment.publicKeySpki,
        nowSeconds: Math.floor(at / 1000),
      })
      if (
        !verifyLibraryProof({
          headers,
          token,
          agentId,
          farmId,
          publicKeySpki: enrollment.publicKeySpki,
          at,
        })
      )
        return null
    } catch {
      return null
    }
    return { agentId, farmId }
  }
}

/** Blob lookup, enrollment read and audit rows on the `farm_library` login. */
export class PostgresConnectorLibraryDownloads implements ConnectorEnrollmentReader {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }

  async find(farmId: string, agentId: string) {
    const rows = await this.sql<{ status: string; publicKeySpki: string }[]>`
      SELECT status, public_key_spki AS "publicKeySpki"
      FROM farm.connector_enrollments
      WHERE farm_id = ${farmId}::uuid AND agent_id = ${agentId}::uuid`
    return rows[0] ?? null
  }

  /** Only a file of this farm that has not been purged. */
  async findBlob(
    farmId: string,
    sha256: string,
  ): Promise<LibraryBlobRecord | null> {
    const rows = await this.sql<LibraryBlobRecord[]>`
      SELECT storage_location AS "storageLocation", size_bytes::float8 AS "sizeBytes"
      FROM farm.library_blobs
      WHERE farm_id = ${farmId}::uuid AND sha256 = ${sha256} AND purged_at IS NULL`
    return rows[0] ?? null
  }

  async audit(entry: DownloadAuditEntry): Promise<void> {
    await this.sql`
      INSERT INTO farm.library_download_audit
        (farm_id, agent_id, sha256, outcome, range_start, range_end, bytes, occurred_at)
      VALUES (${entry.farmId}::uuid, ${entry.agentId}::uuid, ${entry.sha256}, ${entry.outcome},
        ${entry.range?.start ?? null}, ${entry.range?.end ?? null}, ${entry.bytes}, ${entry.occurredAt})`
  }
}

/**
 * Composes the download handler from its ports and activates the route. The
 * returned `stop` deactivates it again. Throws when a handler is already active.
 */
export function startConnectorLibraryDownload(
  input: Omit<ConnectorLibraryDownloadDeps, 'authenticate'> & {
    credentials: ConnectorCredentialPolicy
    enrollments: ConnectorEnrollmentReader
  },
): { stop(): void } {
  const { credentials, enrollments, ...deps } = input
  const handler = createConnectorLibraryDownload({
    ...deps,
    authenticate: createConnectorLibraryAuthenticator({
      credentials,
      enrollments,
      ...(deps.now ? { now: deps.now } : {}),
    }),
  })
  activateConnectorLibraryDownload(handler)
  return {
    stop() {
      if (active === handler) deactivateConnectorLibraryDownload()
    },
  }
}
