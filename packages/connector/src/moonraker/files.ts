import { z } from 'zod'

export type MoonrakerFilesClient = {
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
    files.map(async ({ path, ...file }) => {
      try {
        const metadata = z
          .object({ estimated_time: z.number().finite().nonnegative() })
          .safeParse(
            await client.request('server.files.metadata', { filename: path }),
          )
        return metadata.success
          ? { ...file, estimatedTime: metadata.data.estimated_time }
          : file
      } catch {
        return file
      }
    }),
  )
}
