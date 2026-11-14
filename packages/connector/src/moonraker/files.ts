import { z } from 'zod'
import {
  moonrakerSession,
  moonrakerAuthHeaders,
  type MoonrakerLimits,
} from '../config/moonraker.ts'

export type MoonrakerFilesClient = {
  /** Fetch a Connector-local gcodes path; never a browser URL. */
  downloadThumbnail?(path: string): Promise<Response>
  request(method: string, params: object): Promise<unknown>
}

const File = z.object({
  path: z.string().min(1),
  size: z.number().finite().nonnegative(),
  modified: z.number().finite().nonnegative(),
})

export async function listMoonrakerFiles(
  client: MoonrakerFilesClient,
  { limit }: { limit: number },
): Promise<
  Array<{
    name: string
    size: number
    modified: number
    estimatedTime?: number
    thumbnail?: string
  }>
> {
  const result = await client.request('server.files.list', { root: 'gcodes' })
  if (!Array.isArray(result)) throw new Error('Invalid Moonraker file list')
  const count = Number.isFinite(limit)
    ? Math.max(0, Math.min(200, Math.floor(limit)))
    : 0
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
    .slice(0, count)
  return Promise.all(
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
              (item) => item.size <= 65536 && safeRelative(item.relative_path),
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
  )
}

function safeRelative(path: string): boolean {
  return (
    !/[\\%?#:\u0000-\u0020\u007f]/.test(path) &&
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
