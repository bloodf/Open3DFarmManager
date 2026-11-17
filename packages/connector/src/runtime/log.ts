import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../../../shared/src/log.ts'

/** Local JSONL diagnostics, separate from the CLI's existing output streams. */
export function createRuntimeLogger(dataDirectory: string) {
  const path = join(dataDirectory, 'runtime.jsonl')
  return createLogger('connector', (line) => {
    // Open per entry so failed storage can recover without restarting the agent.
    // createLogger contains sink failures; diagnostics cannot stop safety work.
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    )
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
        return
      writeSync(fd, `${line}\n`)
    } finally {
      closeSync(fd)
    }
  })
}
