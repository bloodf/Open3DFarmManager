import { createError, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { createLogger } from '@open3dfarmmanager/shared'
import {
  authenticatedSession,
  authResponse,
  sealedSessionRecordId,
} from '../../services/authenticated-session.ts'
import { readPrinterAssignmentBody } from '../../services/printer-assignments.ts'
import { checkMutationOrigin } from '../auth/boundary.ts'
import { authRuntime, type AuthRuntime } from '../auth/runtime.ts'
import { inventoryUuid } from '../../storage/postgres-connector-inventory.ts'
import { BlobStoreError, type BlobStore } from './blob-store.ts'
import { blobSource, defined, ingest, type RangeSource } from './ingest.ts'
import { libraryRuntime } from './runtime.ts'
import type {
  LibraryCursor,
  LibraryFailure,
  LibraryVersion,
  PostgresLibrary,
} from './store.ts'

const log = createLogger('farm-library')

/** Hard cap of one uploaded file. */
export const LIBRARY_MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const DEFAULT_PAGE = 50
const MAX_PAGE = 100

export type LibraryStore = Pick<
  PostgresLibrary,
  | 'getSettings'
  | 'getUsage'
  | 'setSettings'
  | 'uploadContext'
  | 'addVersion'
  | 'searchItems'
  | 'getVersion'
  | 'getVersionBySha256'
  | 'listVersions'
  | 'softDeleteVersion'
>

/**
 * Connector-mode transport: the server streams the bytes through to the
 * Connector and keeps none of them. Parsing reads ranges back from the Connector.
 */
export interface ConnectorLibraryRelay {
  put(input: {
    farmId: string
    agentId: string
    body: AsyncIterable<Uint8Array>
    maxBytes: number
  }): Promise<{ sha256: string; size: number; created: boolean }>
  read(input: {
    farmId: string
    agentId: string
    sha256: string
    offset: number
    length: number
  }): Promise<Uint8Array>
  /** Drops a file this upload just created and no version references. */
  discard(input: {
    farmId: string
    agentId: string
    sha256: string
  }): Promise<void>
}

export interface LibraryRuntime {
  store: LibraryStore
  /** Server mode storage; absent when `OPENFARM_LIBRARY_DIR` is not configured. */
  blobs?: Pick<BlobStore, 'put' | 'read' | 'remove'>
  /** Connector mode transport; absent until a Connector link is wired. */
  relay?: ConnectorLibraryRelay
}

export type LibraryOperation =
  | 'list'
  | 'upload'
  | 'get'
  | 'replay-source'
  | 'thumbnail'
  | 'delete'
  | 'versions'
  | 'settings'
  | 'settings-update'

const METHOD: Record<LibraryOperation, string> = {
  list: 'GET',
  upload: 'POST',
  get: 'GET',
  'replay-source': 'GET',
  thumbnail: 'GET',
  delete: 'DELETE',
  versions: 'GET',
  settings: 'GET',
  'settings-update': 'PUT',
}
const MUTATIONS: LibraryOperation[] = ['upload', 'delete', 'settings-update']

const invalid = (message = 'Solicitação inválida.') =>
  createError({ status: 400, message })

/** E8.6: a farm the caller is not in is unknown for reads and forbidden for writes. */
function failure(
  reason: LibraryFailure['reason'] | 'conflict',
  mutation: boolean,
  message?: string,
): never {
  switch (reason) {
    case 'invalid-input':
      throw invalid()
    case 'unauthorized':
      throw createError({
        status: 401,
        message: 'Entre novamente para usar a biblioteca.',
      })
    case 'forbidden':
      throw mutation
        ? createError({
            status: 403,
            message: 'Esta conta não pode alterar a biblioteca desta farm.',
          })
        : createError({
            status: 404,
            message: 'Farm indisponível para esta conta.',
          })
    case 'denied':
      throw createError({
        status: 403,
        message: 'Seu papel nesta farm não permite esta ação.',
      })
    case 'not-found':
      throw createError({ status: 404, message: 'Item não encontrado.' })
    case 'mode-mismatch':
    case 'conflict':
      throw createError({
        status: 409,
        message:
          'O modo de armazenamento mudou durante o envio. Envie o arquivo novamente.',
      })
    case 'quota-exceeded':
      throw createError({
        status: 507,
        message: message ?? 'A cota da biblioteca desta farm foi atingida.',
      })
    case 'storage-unavailable':
      throw createError({
        status: 503,
        message: 'Biblioteca indisponível. Tente novamente.',
      })
  }
}

const settingsBody = z.strictObject({
  storageMode: z.enum(['server', 'connector']).optional(),
  quotaBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  keepVersions: z.number().int().min(1).max(1000).nullable().optional(),
})

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value))
const searchQuery = z.strictObject({
  title: text(200).optional(),
  tag: text(64).optional(),
  printerModel: text(128).optional(),
  slicer: text(128).optional(),
  material: text(64).optional(),
  nozzle: z.coerce.number().positive().max(10).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  cursor: z.string().max(256).optional(),
})
const uploadQuery = z.strictObject({
  name: text(255),
  title: text(200).optional(),
  itemId: z.string().regex(inventoryUuid).optional(),
  agentId: z.string().regex(inventoryUuid).optional(),
  notes: z.string().max(2000).optional(),
  tag: z.array(text(64)).max(32).optional(),
})

function query(url: string, multiple: string[] = []) {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of new URL(url).searchParams) {
    const current = out[key]
    if (!multiple.includes(key) && current !== undefined) throw invalid()
    out[key] = multiple.includes(key)
      ? [...((current as string[] | undefined) ?? []), value]
      : value
  }
  return out
}

const encodeCursor = (c: LibraryCursor) =>
  Buffer.from(JSON.stringify([c.createdAt, c.id])).toString('base64url')
function decodeCursor(value: string): LibraryCursor {
  try {
    const [createdAt, id] = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as [unknown, unknown]
    if (
      typeof createdAt === 'number' &&
      Number.isSafeInteger(createdAt) &&
      typeof id === 'string' &&
      inventoryUuid.test(id)
    )
      return { createdAt, id }
  } catch {
    // fall through
  }
  throw invalid('Cursor inválido.')
}

/** A version as the API shows it: the thumbnail payload has its own route. */
function publicVersion(version: LibraryVersion) {
  const { thumbnail: _thumbnail, ...metadata } = version.metadata
  return { ...version, metadata }
}

function boundary(
  event: Pick<RequestEvent, 'req'>,
  origin: string,
  op: LibraryOperation,
) {
  if (event.req.method !== METHOD[op])
    throw createError({ status: 405, message: 'Método não permitido.' })
  if (!MUTATIONS.includes(op)) return
  if (!checkMutationOrigin(event.req.headers.get('origin'), origin).ok)
    throw createError({
      status: 403,
      message: 'Origem da solicitação não permitida.',
    })
  if (event.req.headers.has('content-encoding'))
    throw createError({
      status: 415,
      message: 'Envie os dados sem compressão.',
    })
}

const kindOf = (name: string) => {
  const ext = /\.(gcode|3mf)$/i.exec(name)?.[1]?.toLowerCase()
  return ext === 'gcode' || ext === '3mf' ? ext : undefined
}

async function upload(
  event: Pick<RequestEvent, 'req' | 'res'>,
  runtime: LibraryRuntime,
  authority: Authority,
) {
  const { req } = event
  if (new URL(req.url).hash !== '') throw invalid()
  const parsed = uploadQuery.safeParse(query(req.url, ['tag']))
  if (!parsed.success)
    throw invalid('Informe o nome do arquivo e os dados do item.')
  const q = parsed.data
  const kind = kindOf(q.name)
  if (!kind)
    throw createError({
      status: 415,
      message: 'Envie um arquivo .gcode ou .3mf.',
    })
  if (
    req.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/octet-stream'
  )
    throw createError({
      status: 415,
      message: 'Envie o arquivo como application/octet-stream.',
    })
  const length = req.headers.get('content-length')
  if (
    length !== null &&
    (!/^\d{1,12}$/.test(length) || Number(length) > LIBRARY_MAX_UPLOAD_BYTES)
  )
    throw createError({
      status: 413,
      message: 'O arquivo excede o limite de 512 MiB.',
    })
  if (!req.body) throw invalid('Envie o conteúdo do arquivo.')

  // Refuse before any byte moves: role, mode and Connector enrolment.
  const context = await runtime.store.uploadContext({
    ...authority,
    ...(q.agentId ? { agentId: q.agentId } : {}),
  })
  if (!context.ok) return failure(context.reason, true)
  const mode = context.settings.storageMode
  const body = req.body as unknown as AsyncIterable<Uint8Array>
  const unavailable = () =>
    createError({
      status: 503,
      message:
        mode === 'server'
          ? 'Armazenamento do servidor não configurado.'
          : 'Conector indisponível para receber o arquivo.',
    })

  let stored: { sha256: string; size: number; created: boolean }
  let source: RangeSource
  let discard: () => Promise<void>
  let confirmFile: () => Promise<void>
  try {
    if (mode === 'server') {
      const blobs = runtime.blobs
      if (!blobs) throw unavailable()
      stored = await blobs.put(body, { maxBytes: LIBRARY_MAX_UPLOAD_BYTES })
      source = blobSource(blobs, stored.sha256, stored.size)
      const sha256 = stored.sha256
      discard = async () => {
        await blobs.remove(sha256)
      }
      // Opening a missing file throws.
      confirmFile = async () => {
        ;(await blobs.read(sha256)).stream.destroy()
      }
    } else {
      const relay = runtime.relay
      const agentId = q.agentId
      if (!relay || !agentId) throw unavailable()
      const common = { farmId: authority.farmId, agentId }
      stored = await relay.put({
        ...common,
        body,
        maxBytes: LIBRARY_MAX_UPLOAD_BYTES,
      })
      const { sha256, size } = stored
      source = {
        size,
        read: (offset, length) =>
          relay.read({ ...common, sha256, offset, length }),
      }
      discard = () => relay.discard({ ...common, sha256 })
      // Reading a missing file throws.
      confirmFile = async () => {
        await relay.read({ ...common, sha256, offset: 0, length: 1 })
      }
    }
  } catch (error) {
    if (error instanceof BlobStoreError && error.code === 'too-large')
      throw createError({
        status: 413,
        message: 'O arquivo excede o limite de 512 MiB.',
      })
    if (error instanceof Error && 'status' in error) throw error
    log.error('library upload failed before indexing')
    throw unavailable()
  }

  // From here a file this request created and no version references is removed.
  let keep = false
  try {
    const result = await ingest(kind, source)
    if (!result.ok) throw createError({ status: 422, message: result.reason })
    const added = await runtime.store.addVersion({
      ...authority,
      confirmFile,
      version: {
        ...(q.itemId
          ? { itemId: q.itemId }
          : {
              title:
                (q.title ?? q.name.replace(/\.(gcode|3mf)$/i, '').trim()) ||
                q.name,
            }),
        tags: q.tag ?? [],
        sha256: stored.sha256,
        sizeBytes: stored.size,
        location: mode,
        ...(mode === 'connector' ? { agentId: q.agentId! } : {}),
        originalName: q.name,
        kind,
        plateCount: result.plateCount,
        metadata: result.metadata,
        ...(q.notes ? { notes: q.notes } : {}),
      },
    })
    if (!added.ok)
      return failure(
        added.reason,
        true,
        'message' in added ? added.message : undefined,
      )
    // Keep the stored file only when the recorded version actually points to it.
    keep =
      !added.orphanedServerCopy &&
      added.version.storageLocation === mode &&
      (mode === 'server' || added.version.agentId === q.agentId)
    event.res.status = 201
    return {
      item: added.item,
      version: publicVersion(added.version),
      deduplicated: added.deduplicated,
    }
  } finally {
    if (stored.created && !keep)
      await discard().catch(() => log.error('library cleanup failed'))
  }
}

type Authority = {
  sessionRecordId: string
  policy: { idleTimeoutMs: number }
  farmId: string
}

export async function libraryRoutes(
  event: Pick<RequestEvent, 'req' | 'res'>,
  operation: LibraryOperation,
  target: { farmId: string; versionId?: string; itemId?: string },
  dependencies?: { auth: AuthRuntime; runtime: LibraryRuntime },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  event.res.headers.set('X-Content-Type-Options', 'nosniff')
  event.res.headers.set('Vary', 'Cookie')
  const mutation = MUTATIONS.includes(operation)
  const needsVersion =
    operation === 'get' || operation === 'thumbnail' || operation === 'delete'
  if (
    !inventoryUuid.test(target.farmId) ||
    (needsVersion &&
      !(target.versionId && inventoryUuid.test(target.versionId))) ||
    (operation === 'versions' &&
      !(target.itemId && inventoryUuid.test(target.itemId)))
  )
    throw invalid()
  const auth = dependencies?.auth ?? authRuntime()
  boundary(event, auth.origin, operation)
  await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  try {
    if (
      !(await auth.credentials.consumeLimit(
        's',
        `library:${operation}:${sessionRecordId}`,
      ))
    )
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Aguarde antes de tentar novamente.',
      })
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    return failure('storage-unavailable', mutation)
  }
  const runtime = dependencies?.runtime ?? (await libraryRuntime())
  const authority: Authority = {
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
    farmId: target.farmId,
  }

  if (operation === 'upload') return upload(event, runtime, authority)

  if (operation === 'settings') {
    const result = await runtime.store.getSettings(authority)
    if (!result.ok) return failure(result.reason, false)
    // Used and available space for the active mode, for the people who manage it.
    const usage = result.canManage
      ? await runtime.store.getUsage(authority)
      : undefined
    return {
      settings: result.settings,
      locations: result.locations,
      ...(usage?.ok ? { usage: usage.usage } : {}),
      canManage: result.canManage,
    }
  }

  if (operation === 'settings-update') {
    const body = settingsBody.safeParse(
      await readPrinterAssignmentBody(event.req),
    )
    if (!body.success) throw invalid()
    const result = await runtime.store.setSettings({
      ...authority,
      ...defined(body.data),
    })
    if (!result.ok) return failure(result.reason, true)
    // A switch only affects future uploads; this is where earlier files stay.
    return { settings: result.settings, locations: result.locations }
  }

  if (operation === 'list') {
    const parsed = searchQuery.safeParse(query(event.req.url))
    if (!parsed.success) throw invalid('Filtros inválidos.')
    const { limit, cursor, ...search } = parsed.data
    const result = await runtime.store.searchItems({
      ...authority,
      search: defined(search),
      limit: limit ?? DEFAULT_PAGE,
      ...(cursor ? { after: decodeCursor(cursor) } : {}),
    })
    if (!result.ok) return failure(result.reason, false)
    return {
      items: result.items.map((item) => ({
        ...item,
        latest: publicVersion(item.latest),
      })),
      nextCursor: result.next ? encodeCursor(result.next) : null,
    }
  }

  if (operation === 'replay-source') {
    const parsed = z
      .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .safeParse(query(event.req.url))
    if (!parsed.success) throw invalid()
    const result = await runtime.store.getVersionBySha256({
      ...authority,
      sha256: parsed.data.sha256,
    })
    if (!result.ok) return failure(result.reason, false)
    return { version: publicVersion(result.version) }
  }

  if (operation === 'versions') {
    const result = await runtime.store.listVersions({
      ...authority,
      itemId: target.itemId!,
    })
    if (!result.ok) return failure(result.reason, false)
    return { versions: result.versions.map(publicVersion) }
  }

  if (operation === 'delete') {
    const result = await runtime.store.softDeleteVersion({
      ...authority,
      versionId: target.versionId!,
    })
    if (!result.ok) return failure(result.reason, true)
    return { deleted: true, deletedAt: result.deletedAt }
  }

  const result = await runtime.store.getVersion({
    ...authority,
    versionId: target.versionId!,
  })
  if (!result.ok) return failure(result.reason, false)
  if (operation === 'get')
    return { item: result.item, version: publicVersion(result.version) }

  // Thumbnail: the hash fixes the content, so the browser may keep it.
  const thumbnail = result.version.metadata.thumbnail
  if (!thumbnail)
    throw createError({ status: 404, message: 'Miniatura indisponível.' })
  const etag = `"${result.version.sha256}"`
  const headers = new Headers({
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: etag,
  })
  event.res.headers.delete('Pragma')
  for (const [k, v] of headers) event.res.headers.set(k, v)
  if (
    event.req.headers
      .get('if-none-match')
      ?.split(',')
      .some((t) => t.trim() === etag || t.trim() === '*')
  )
    return new Response(null, { status: 304, headers })
  headers.set('Content-Type', thumbnail.mimeType)
  return new Response(Buffer.from(thumbnail.data, 'base64'), { headers })
}
