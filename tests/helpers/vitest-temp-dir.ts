import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export async function setup() {
  if (process.env.TMPDIR || process.platform !== 'linux') return

  // Browser profiles and compiled SFCs can exhaust the host /tmp inode pool.
  const cache = join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'openfarm-checks',
  )
  await mkdir(cache, { recursive: true })
  const scratch = await mkdtemp(join(cache, 'vitest-'))
  process.env.TMPDIR = scratch

  return async () => {
    delete process.env.TMPDIR
    await rm(scratch, { recursive: true, force: true })
  }
}
