/**
 * HTTP-free import pipeline: validate the request, read or parse the source,
 * normalize it, then hand it to the transactional store. The route and the
 * Docker evidence script both call this, so what is tested is what ships.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  SOURCE_KEY,
  type ImportAuthority,
  type ImportFailureReason,
  type ImportFormat,
  type ImportOptions,
  type ImportReport,
  type PostgresSpoolLibraryImport,
} from '../../storage/postgres-spool-library-import.ts'
import { normalizeBundle, type BundleProblem } from './bundle.ts'
import { csvToBundleInput } from './csv.ts'
import {
  canonicalOrigin,
  readSpoolmanLibrary,
  SourceError,
  type SourceFailure,
} from './spoolman-source.ts'

export const MAX_IMPORT_BYTES = 12 * 1024 * 1024

const common = {
  /** Stable name of the upstream library. Reuse it to make repeated imports idempotent. */
  source: z.string().regex(SOURCE_KEY).optional(),
  dryRun: z.boolean().default(false),
  onCollision: z.enum(['adopt', 'create']).default('adopt'),
  onConflict: z.enum(['keep-local', 'overwrite']).default('keep-local'),
}
export const spoolLibraryImportBody = z.discriminatedUnion('format', [
  z.strictObject({
    format: z.literal('spoolman-api'),
    origin: z.string().max(255),
    /** Optional, sent only as an Authorization header to that origin; never stored or logged. */
    bearerToken: z.string().min(1).max(512).optional(),
    ...common,
  }),
  z.strictObject({
    format: z.literal('json'),
    data: z.record(z.string(), z.unknown()),
    ...common,
  }),
  z.strictObject({
    format: z.literal('csv'),
    entity: z.enum(['vendors', 'filaments', 'spools']),
    csv: z.string().max(MAX_IMPORT_BYTES),
    ...common,
  }),
])
export type SpoolLibraryImportBody = z.infer<typeof spoolLibraryImportBody>

export type PipelineFailure =
  ImportFailureReason | SourceFailure | 'source-not-allowed'
export type PipelineResult =
  | { ok: true; report: ImportReport }
  | { ok: false; reason: PipelineFailure; problems?: BundleProblem[] }

export interface PipelineDependencies {
  importer: Pick<PostgresSpoolLibraryImport, 'importBundle'>
  /** Exact origins the server may read; empty disables API import. */
  allowedOrigins: readonly string[]
  fetch?: typeof fetch | undefined
}

export async function runSpoolLibraryImport(
  authority: ImportAuthority,
  body: SpoolLibraryImportBody,
  deps: PipelineDependencies,
): Promise<PipelineResult> {
  let raw: unknown
  let defaultSource: string
  if (body.format === 'spoolman-api') {
    const origin = canonicalOrigin(body.origin)
    if (!origin) return { ok: false, reason: 'invalid-input' }
    if (!deps.allowedOrigins.includes(origin))
      return { ok: false, reason: 'source-not-allowed' }
    defaultSource = `spoolman-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`
    try {
      raw = await readSpoolmanLibrary({
        origin,
        bearerToken: body.bearerToken,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    } catch (error) {
      // Only the failure class leaves this function: no URL, token or driver text.
      return {
        ok: false,
        reason:
          error instanceof SourceError ? error.reason : 'source-unavailable',
      }
    }
  } else if (body.format === 'json') {
    raw = body.data
    defaultSource = 'json-default'
  } else {
    const csv = csvToBundleInput(body.entity, body.csv)
    if (!csv.ok)
      return { ok: false, reason: 'invalid-input', problems: csv.problems }
    raw = csv.input
    defaultSource = 'csv-default'
  }
  const bundle = normalizeBundle(raw)
  if (!bundle.ok)
    return { ok: false, reason: 'invalid-input', problems: bundle.problems }
  const format: ImportFormat = body.format
  const options: ImportOptions = {
    sourceKey: body.source ?? defaultSource,
    format,
    dryRun: body.dryRun,
    onCollision: body.onCollision,
    onConflict: body.onConflict,
  }
  const result = await deps.importer.importBundle(
    authority,
    bundle.bundle,
    options,
  )
  return result.ok
    ? { ok: true, report: result.report }
    : {
        ok: false,
        reason: result.reason,
        ...(result.problems ? { problems: result.problems } : {}),
      }
}
