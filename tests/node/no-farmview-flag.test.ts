import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const app = fileURLToPath(new URL('../../apps/farm/app/', import.meta.url))

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? sourceFiles(path) : [path]
    }),
  )
  return files.flat()
}

test('farmView flag name is absent from app code', async () => {
  const files = await sourceFiles(app)
  const matches = await Promise.all(
    files.map(async (file) =>
      /\bfarmView\b/.test(await readFile(file, 'utf8')) ? file : null,
    ),
  )
  assert.deepEqual(matches.filter(Boolean), [])
})
