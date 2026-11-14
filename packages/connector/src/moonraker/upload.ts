import { createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

export type MoonrakerUploadFailure =
  'unauthorized' | 'too-large' | 'timeout' | 'aborted' | 'offline'

export class MoonrakerUploadError extends Error {
  readonly reason: MoonrakerUploadFailure
  constructor(reason: MoonrakerUploadFailure) {
    super(`Moonraker upload failed: ${reason}`)
    this.name = 'MoonrakerUploadError'
    this.reason = reason
  }
}

export async function uploadMoonrakerFile(input: {
  origin: string
  apiKey?: string
  filePath: string
  name: string
  signal: AbortSignal
}): Promise<void> {
  const boundary = `----connector-${randomUUID()}`
  const filename = input.name.replace(/[\r\n"\\]/g, '_')
  const file = createReadStream(input.filePath)
  const timeout = AbortSignal.timeout(30_000)
  const signal = AbortSignal.any([input.signal, timeout])
  async function* parts() {
    yield `--${boundary}\r\nContent-Disposition: form-data; name="root"\r\n\r\ngcodes\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    yield* file
    yield `\r\n--${boundary}--\r\n`
  }
  const body = Readable.from(parts())
  try {
    const response = await fetch(`${input.origin}/server/files/upload`, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...(input.apiKey ? { 'X-Api-Key': input.apiKey } : {}),
      },
      body: body as unknown as BodyInit,
      duplex: 'half',
      signal,
      redirect: 'error',
    } as RequestInit & { duplex: 'half' })
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403)
      throw new MoonrakerUploadError('unauthorized')
    if (response.status === 413) throw new MoonrakerUploadError('too-large')
    if (!response.ok) throw new MoonrakerUploadError('offline')
  } catch (error) {
    if (error instanceof MoonrakerUploadError) throw error
    throw new MoonrakerUploadError(
      input.signal.aborted
        ? 'aborted'
        : timeout.aborted
          ? 'timeout'
          : 'offline',
    )
  } finally {
    body.destroy()
    file.destroy()
  }
}
