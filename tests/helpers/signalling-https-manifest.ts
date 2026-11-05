import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'

export const Receipt = z.strictObject({
  head: z.string().regex(/^[a-f0-9]{40}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputFiles: z.number().int().min(1).max(10000),
})

export async function outputSnapshot(root: string) {
  const entries: { path: string; size: number; sha256: string }[] = []
  let total = 0
  async function walk(directory: string) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const stat = await lstat(path)
        total += stat.size
        if (
          !stat.isFile() ||
          stat.size > 64 * 1024 * 1024 ||
          total > 512 * 1024 * 1024 ||
          entries.length >= 10000
        )
          throw new Error('Output exceeds fixture bounds')
        entries.push({
          path: relative(root, path),
          size: stat.size,
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        })
      } else
        throw new Error(
          'Output must contain regular files and directories only',
        )
    }
  }
  await walk(root)
  if (!entries.some((entry) => entry.path === 'server/index.mjs'))
    throw new Error('Generated Nitro entry missing')
  return {
    outputSha256: createHash('sha256')
      .update(JSON.stringify(entries))
      .digest('hex'),
    outputFiles: entries.length,
    entries,
  }
}

export async function createFixtureReceipt(
  root: string,
  source: { head: string; sourceSha256: string },
  configSha256: string,
) {
  const { entries, ...output } = await outputSnapshot(root)
  return {
    entries,
    receipt: Receipt.parse({ ...source, configSha256, ...output }),
  }
}
