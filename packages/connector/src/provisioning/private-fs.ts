import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { readPrivateJsonFile } from '../config/local.ts'

/**
 * Private local custody primitives for provisioning state. Every path is an
 * absolute, already-resolved location owned by the current user with no group
 * or other permission bits. Symbolic links are never followed, at any level.
 */
export class ProvisioningStorageError extends Error {
  constructor() {
    super('Provisioning storage unavailable')
  }
}
const fail = (): never => {
  throw new ProvisioningStorageError()
}

function privateStat(stat: Stats, directory: boolean): void {
  if (
    process.platform === 'win32' ||
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    fail()
}

function resolvedAbsolute(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    fail()
  // realpath equality rejects a symbolic link in any ancestor component.
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return fail()
  }
  if (real !== path) fail()
}

/** Creates (0700) or validates a private directory. Never follows links. */
export function ensurePrivateDirectory(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path)) fail()
  resolvedAbsolute(dirname(path))
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      fail()
  }
  privateStat(lstatSync(path), true)
  resolvedAbsolute(path)
}

/** Validates an existing private file target (or its absence). */
function checkTarget(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return false
  privateStat(stat, false)
  return true
}

/** Bounded private JSON read; `null` only when the file is absent. */
export function readPrivateJson(
  path: string,
  maxBytes = 64 * 1024,
): unknown | null {
  resolvedAbsolute(dirname(path))
  if (!checkTarget(path)) return null
  try {
    return readPrivateJsonFile(path, { maxBytes, maxStringChars: 2048 })
  } catch {
    return fail()
  }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Write-then-rename publication: exclusive private temp file, fsync, atomic
 * rename over the target and directory fsync. An existing target must already
 * be a private regular file. `validate` runs against the durable temp file
 * before publication; failures leave the previous content intact.
 */
export function writePrivateJsonAtomic(
  path: string,
  value: unknown,
  validate?: (temporaryPath: string) => void,
): void {
  const directory = dirname(path)
  resolvedAbsolute(directory)
  privateStat(lstatSync(directory), true)
  checkTarget(path)
  const body = JSON.stringify(value)
  if (body === undefined || Buffer.byteLength(body) > 64 * 1024) fail()
  const temporary = join(
    directory,
    `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`,
  )
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  )
  let published = false
  try {
    try {
      writeSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    validate?.(temporary)
    renameSync(temporary, path)
    published = true
    syncDirectory(directory)
  } finally {
    if (!published) unlinkSync(temporary)
  }
}

/** Removes a private file this module owns; absent is success. */
export function removePrivateFile(path: string): void {
  resolvedAbsolute(dirname(path))
  if (!checkTarget(path)) return
  unlinkSync(path)
  syncDirectory(dirname(path))
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ESRCH'
    )
  }
}

/**
 * Exclusive cross-process lock (O_EXCL). A lock whose recorded process no
 * longer exists is stale and is replaced; a live holder means busy.
 */
export function acquirePrivateLock(path: string): (() => void) | null {
  resolvedAbsolute(dirname(path))
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      )
      try {
        writeSync(fd, `${process.pid}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        unlinkSync(path)
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        return fail()
    }
    const stat = lstatSync(path)
    privateStat(stat, false)
    if (stat.size > 32) fail()
    const lockFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let text: string
    try {
      text = readFileSync(lockFd, 'utf8')
    } finally {
      closeSync(lockFd)
    }
    if (!/^[1-9][0-9]{0,9}\n$/.test(text)) fail()
    const pid = Number(text.trim())
    if (pid === process.pid || processAlive(pid)) return null
    unlinkSync(path)
  }
  return null
}
