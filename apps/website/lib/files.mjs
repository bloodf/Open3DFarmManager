// Small filesystem helpers shared by build.mjs and verify.mjs.
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

export async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

/** Every file below `dir`, as sorted POSIX-style relative paths. */
export async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory()
        ? listFiles(full, base)
        : [path.relative(base, full).split(path.sep).join('/')]
    }),
  )
  return nested.flat().sort()
}

/** True when `child` is `parent` or lies inside it. */
export function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}
