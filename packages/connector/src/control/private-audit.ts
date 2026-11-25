import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** Bound for one audit file. A full file rotates to `.1`, replacing the older one. */
export const PRIVATE_AUDIT_MAX_BYTES = 1024 * 1024

function privateOwned(stat: { mode: number; uid: number }): boolean {
  return (
    process.platform === 'win32' ||
    ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.())
  )
}

/**
 * Appends one fsynced line to `<directory>/<name>`. The directory must be a
 * private, owned, real directory; the file must be a private single-link regular
 * file. Throws when the line could not be made durable.
 */
export function appendPrivateAudit(
  directory: string,
  name: string,
  line: string,
): void {
  let fd: number | undefined
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const entry = lstatSync(directory)
    if (!entry.isDirectory() || !privateOwned(entry))
      throw new Error('Audit directory is not private')
    const path = join(directory, name)
    const open = () =>
      openSync(
        path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW,
        0o600,
      )
    fd = open()
    let stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || !privateOwned(stat))
      throw new Error('Audit unavailable')
    if (stat.size + Buffer.byteLength(line) > PRIVATE_AUDIT_MAX_BYTES) {
      closeSync(fd)
      fd = undefined
      renameSync(path, path + '.1')
      // Persist the rename before the new file is created.
      const directoryFd = openSync(directory, constants.O_RDONLY)
      try {
        fsyncSync(directoryFd)
      } finally {
        closeSync(directoryFd)
      }
      fd = open()
      stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || !privateOwned(stat))
        throw new Error('Audit unavailable')
    }
    writeSync(fd, line)
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
