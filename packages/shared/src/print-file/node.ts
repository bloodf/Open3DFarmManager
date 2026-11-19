import { open } from 'node:fs/promises'
import {
  readGcodeMetadata,
  emptyPrintFileMetadata,
  type GcodeByteSource,
} from './gcode-meta.ts'
import type { PrintFileMetadata } from './schema.ts'

export interface GcodeFileSource extends GcodeByteSource {
  /** Total bytes returned by read() so far. */
  readonly bytesRead: number
  close(): Promise<void>
}

/** Opens a file as a random-access source that counts the bytes it reads. */
export async function openGcodeFileSource(
  path: string,
): Promise<GcodeFileSource> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    let bytesRead = 0
    return {
      size,
      get bytesRead() {
        return bytesRead
      },
      async read(offset, length) {
        const buffer = new Uint8Array(length)
        let filled = 0
        while (filled < length) {
          const { bytesRead: n } = await handle.read(
            buffer,
            filled,
            length - filled,
            offset + filled,
          )
          if (n === 0) break
          filled += n
        }
        bytesRead += filled
        return buffer.subarray(0, filled)
      },
      close: () => handle.close(),
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Reads metadata from a G-code file on disk; an unreadable file yields the empty result. */
export async function readGcodeFileMetadata(
  path: string,
): Promise<PrintFileMetadata> {
  let source: GcodeFileSource
  try {
    source = await openGcodeFileSource(path)
  } catch {
    return emptyPrintFileMetadata()
  }
  try {
    return await readGcodeMetadata(source)
  } finally {
    await source.close().catch(() => undefined)
  }
}
