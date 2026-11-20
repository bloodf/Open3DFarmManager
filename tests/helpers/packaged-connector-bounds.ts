import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'

export const PACKAGED_CONNECTOR_LIMITS = {
  files: 96,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
} as const

function assertPackagedBytes(fileBytes: number, totalBytes: number): void {
  if (
    fileBytes > PACKAGED_CONNECTOR_LIMITS.fileBytes ||
    totalBytes > PACKAGED_CONNECTOR_LIMITS.totalBytes
  )
    throw Error('Packaged byte bound')
}

export async function readPackagedConnectorManifest(dist: string) {
  const manifest: { name: string; bytes: number; sha256: string }[] = []
  let totalBytes = 0

  async function visit(relative: string) {
    const directory = join(dist, relative)
    if (!(await lstat(directory)).isDirectory())
      throw Error('Packaged file bound')

    for await (const entry of await opendir(directory)) {
      const name = relative ? relative + '/' + entry.name : entry.name
      // Match the two directory levels copied by the Connector build.
      if (
        entry.isDirectory() &&
        (name === 'notices' || name === 'notices/node-datachannel')
      ) {
        await visit(name)
        continue
      }
      if (
        !entry.isFile() ||
        relative === 'notices' ||
        manifest.length >= PACKAGED_CONNECTOR_LIMITS.files
      )
        throw Error('Packaged file bound')

      const file = await open(
        join(dist, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const stat = await file.stat()
        if (!stat.isFile()) throw Error('Packaged file bound')
        assertPackagedBytes(stat.size, totalBytes + stat.size)
        // One extra byte detects growth without an unbounded read.
        const buffer = Buffer.alloc(stat.size + 1)
        let size = 0
        while (size < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            size,
            buffer.length - size,
          )
          if (bytesRead === 0) break
          size += bytesRead
        }
        if (size !== stat.size) throw Error('Packaged file changed')
        totalBytes += size
        manifest.push({
          name,
          bytes: size,
          sha256: createHash('sha256')
            .update(buffer.subarray(0, size))
            .digest('hex'),
        })
      } finally {
        await file.close()
      }
    }
  }

  await visit('')
  return manifest.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}
