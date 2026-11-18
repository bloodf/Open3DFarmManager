import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { get } from 'node:https'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_FILE_SIZE } from '../../../farm-protocol/src/file-transfer.ts'
import type { ApiEnvelopeJob } from '../../../farm-protocol/src/api-envelope.ts'
import {
  supportsFileUpload,
  uploadFile,
  type FileUploadTarget,
} from './file-upload.ts'

export class JobFileError extends Error {
  readonly reason:
    'unsupported' | 'checksum-mismatch' | 'too-large' | 'download-failed'
  constructor(reason: JobFileError['reason']) {
    super(reason)
    this.reason = reason
  }
}

/** Call only after validating the signed envelope and local printer authority. */
export async function fetchJobFile(input: {
  job: ApiEnvelopeJob
  target: FileUploadTarget
  directory: string
  signal: AbortSignal
  authorize(): boolean
  start(name: string): Promise<void>
  ca?: string | Buffer
  timeoutMs?: number
}): Promise<void> {
  const { job, target } = input
  if (
    !supportsFileUpload(target, job.display_name) ||
    /[\\/\x00-\x1f\x7f]/.test(job.display_name) ||
    job.display_name.includes('..')
  )
    throw new JobFileError('unsupported')
  if (job.size_bytes > MAX_FILE_SIZE) throw new JobFileError('too-large')
  await mkdir(input.directory, { recursive: true })
  const path = join(input.directory, randomUUID())
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.timeoutMs ?? 60_000),
  ])
  try {
    let url = new URL(job.file_url)
    let redirects = 0
    for (;;) {
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new JobFileError('download-failed')
      const response = await new Promise<import('node:http').IncomingMessage>(
        (resolve, reject) => {
          const request = get(
            url,
            { signal, ...(input.ca ? { ca: input.ca } : {}) },
            resolve,
          )
          request.on('error', reject)
        },
      )
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.destroy()
        if (++redirects > 5) throw new JobFileError('download-failed')
        url = new URL(response.headers.location, url)
        continue
      }
      if (response.statusCode !== 200) {
        response.destroy()
        throw new JobFileError('download-failed')
      }
      const length = response.headers['content-length']
      if (length && Number(length) > Math.min(job.size_bytes, MAX_FILE_SIZE)) {
        response.destroy()
        throw new JobFileError('too-large')
      }
      let size = 0
      const hash = createHash('sha256')
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          if (size > job.size_bytes || size > MAX_FILE_SIZE)
            return callback(new JobFileError('too-large'))
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(
        response,
        meter,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal },
      )
      if (size !== job.size_bytes || hash.digest('hex') !== job.sha256)
        throw new JobFileError('checksum-mismatch')
      break
    }
    signal.throwIfAborted()
    if (!input.authorize()) throw new Error('unauthorized')
    await uploadFile({
      target,
      filePath: path,
      name: job.display_name,
      signal,
      authorize: input.authorize,
    })
    signal.throwIfAborted()
    if (!input.authorize()) throw new Error('unauthorized')
    await input.start(job.display_name)
  } finally {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
