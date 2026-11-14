import { open, mkdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  CHUNK_SIZE,
  parseOffer,
} from '../../../farm-protocol/src/file-transfer.ts'
export class FileReceiver {
  private directory: string
  constructor(directory: string) {
    this.directory = directory
  }
  async offer(input: unknown) {
    const offer = parseOffer(input)
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, randomUUID())
    const handle: FileHandle = await open(path, 'wx', 0o600)
    const hash = createHash('sha256')
    let size = 0,
      seq = 0,
      closed = false
    let timer: ReturnType<typeof setTimeout>
    const abort = async () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      await handle.close()
      await unlink(path)
    }
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void abort().catch(() => {})
      }, 60_000)
      timer.unref()
    }
    touch()
    return {
      abort,
      async chunk(sequence: number, bytes: Uint8Array) {
        if (closed) throw new Error('closed')
        if (
          sequence !== seq ||
          !(bytes instanceof Uint8Array) ||
          bytes.length < 1 ||
          bytes.length > CHUNK_SIZE ||
          size + bytes.length > offer.size
        ) {
          await abort()
          throw new Error('invalid_chunk')
        }
        let offset = 0
        while (offset < bytes.length) {
          const result = await handle.write(
            bytes,
            offset,
            bytes.length - offset,
          )
          offset += result.bytesWritten
        }
        hash.update(bytes)
        size += bytes.length
        seq++
        touch()
      },
      async complete() {
        if (closed) throw new Error('closed')
        if (size !== offer.size || hash.digest('hex') !== offer.sha256) {
          await abort()
          throw new Error('integrity')
        }
        closed = true
        clearTimeout(timer)
        await handle.close()
        return {
          path,
          offer,
          async forward<T>(consume: (path: string) => Promise<T>) {
            try {
              return await consume(path)
            } finally {
              await unlink(path)
            }
          },
        }
      },
    }
  }
}
