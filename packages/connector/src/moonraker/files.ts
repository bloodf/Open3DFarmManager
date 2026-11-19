import { z } from 'zod'
import { PrinterGcodePath } from '../../../farm-protocol/src/control-actions.ts'
import {
  moonrakerSession,
  moonrakerAuthHeaders,
  type MoonrakerLimits,
} from '../config/moonraker.ts'

export type MoonrakerFilesClient = {
  /** Fetch a Connector-local gcodes path; never a browser URL. */
  downloadThumbnail?(path: string): Promise<Response>
  request(
    method: string,
    params: object,
    signal?: AbortSignal,
  ): Promise<unknown>
}

const File = z.object({
  path: z.string().min(1),
  size: z.number().finite().nonnegative(),
  modified: z.number().finite().nonnegative(),
})

export async function listMoonrakerFiles(
  client: MoonrakerFilesClient,
  {
    limit,
    metadata = true,
    directory,
  }: { limit: number; metadata?: boolean; directory?: string | undefined },
): Promise<
  Array<{
    name: string
    size: number
    modified: number
    directory?: true
    estimatedTime?: number
    thumbnail?: string
  }>
> {
  const count = Number.isFinite(limit)
    ? Math.max(0, Math.min(200, Math.floor(limit)))
    : 0
  const prefix = directory ? `${PrinterGcodePath.parse(directory)}/` : ''
  const listing =
    directory === undefined
      ? undefined
      : z
          .object({
            dirs: z.array(
              File.omit({ path: true }).extend({ dirname: z.string() }),
            ),
            files: z.array(
              File.omit({ path: true }).extend({ filename: z.string() }),
            ),
          })
          .parse(
            await client.request('server.files.get_directory', {
              path: `gcodes${directory ? '/' + directory : ''}`,
            }),
          )
  const folders =
    listing?.dirs
      .filter(
        ({ dirname }) =>
          !dirname.includes('/') &&
          PrinterGcodePath.safeParse(prefix + dirname).success,
      )
      .slice(0, count)
      .map(({ dirname, size, modified }) => ({
        name: prefix + dirname,
        size,
        modified,
        directory: true as const,
      })) ?? []
  const result = listing
    ? listing.files
        .filter(
          ({ filename }) =>
            !filename.includes('/') &&
            PrinterGcodePath.safeParse(prefix + filename).success,
        )
        .map(({ filename, ...file }) => ({ ...file, path: prefix + filename }))
    : await client.request('server.files.list', { root: 'gcodes' })
  if (!Array.isArray(result)) throw new Error('Invalid Moonraker file list')
  const files = result
    .flatMap((entry: unknown) => {
      const parsed = File.safeParse(entry)
      if (!parsed.success) return []
      const name = parsed.data.path
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        .slice(0, 255)
      return name
        ? [
            {
              name,
              path: parsed.data.path,
              size: parsed.data.size,
              modified: parsed.data.modified,
            },
          ]
        : []
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, Math.max(0, count - folders.length))
  if (!metadata)
    return [
      ...folders,
      ...files.map(({ name, size, modified }) => ({ name, size, modified })),
    ]
  return [
    ...folders,
    ...(await Promise.all(
      files.map(async ({ path, ...file }, index) => {
        try {
          const metadata = z
            .object({
              estimated_time: z.number().finite().nonnegative().optional(),
              thumbnails: z
                .array(
                  z.object({
                    relative_path: z.string(),
                    size: z.number().int().positive(),
                  }),
                )
                .optional(),
            })
            .safeParse(
              await client.request('server.files.metadata', { filename: path }),
            )
          if (!metadata.success) return file
          const result: typeof file & {
            estimatedTime?: number
            thumbnail?: string
          } = { ...file }
          if (metadata.data.estimated_time !== undefined)
            result.estimatedTime = metadata.data.estimated_time
          if (index < 50 && client.downloadThumbnail) {
            const candidate = metadata.data.thumbnails
              ?.filter(
                (item) =>
                  item.size <= 65536 && safeRelative(item.relative_path),
              )
              .sort((a, b) => b.size - a.size)[0]
            if (candidate && safeRelative(path)) {
              const directory = path.includes('/')
                ? path.slice(0, path.lastIndexOf('/') + 1)
                : ''
              try {
                const response = await client.downloadThumbnail(
                  `gcodes/${directory}${candidate.relative_path}`,
                )
                const thumbnail = await readThumbnail(response)
                if (thumbnail) result.thumbnail = thumbnail
              } catch {
                /* Optional preview must not hide the file. */
              }
            }
          }
          return result
        } catch {
          return file
        }
      }),
    )),
  ]
}

function safeRelative(path: string): boolean {
  return (
    !/[\\\u0000-\u001f\u007f-\u009f]/.test(path) &&
    !/%(?:2f|5c|2e)/i.test(path) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  )
}

async function readThumbnail(response: Response): Promise<string | undefined> {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    return undefined
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 65536) return undefined
      chunks.push(item.value)
    }
    const bytes = Buffer.concat(chunks)
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? bytes.toString('base64')
      : undefined
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Uses only the configured printer origin and its private authentication. */
export function createThumbnailDownload(input: {
  origin: string
  limits: MoonrakerLimits
  signal: AbortSignal
}): (path: string) => Promise<Response> {
  return async (path) => {
    if (!path.startsWith('gcodes/') || !safeRelative(path))
      throw Error('Invalid thumbnail path')
    const origin = new URL(input.origin)
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw Error('Invalid thumbnail origin')
    return fetch(
      new URL(
        `/server/files/${path.split('/').map(encodeURIComponent).join('/')}`,
        origin,
      ),
      {
        headers: await (moonrakerSession(
          input.origin,
          input.limits,
        )?.getAuthHeaders() ??
          moonrakerAuthHeaders(input.origin, input.limits)),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.any([
          input.signal,
          AbortSignal.timeout(input.limits.requestTimeoutMs),
        ]),
      },
    )
  }
}
