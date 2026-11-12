import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Host facts used to decide whether a lock owner can still be running. */
export interface LockProbe {
  hostname(): string
  /** Kernel boot identity; undefined when the platform cannot provide one. */
  boot(): string | undefined
  /** PID namespace of this process; undefined when unknown. */
  pidNamespace(): string | undefined
  /** Opaque process start identity; undefined when unreadable. */
  startTime(pid: number): string | undefined
  /** False only when the PID certainly does not exist (ESRCH). */
  alive(pid: number): boolean
}

function optional<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}
export const systemLockProbe: LockProbe = {
  hostname,
  boot: () =>
    optional(() =>
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    ),
  pidNamespace: () => optional(() => readlinkSync('/proc/self/ns/pid')),
  startTime(pid) {
    // Field 22 of /proc/<pid>/stat, counted after the parenthesized command name.
    const stat = optional(() => readFileSync(`/proc/${pid}/stat`, 'utf8'))
    return stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  },
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  },
}

type Owner = {
  version: 2
  pid: number
  host: string
  boot: string | null
  ns: string | null
  start: string | null
  instance: string
}
function describe(probe: LockProbe): Owner {
  return {
    version: 2,
    pid: process.pid,
    host: probe.hostname(),
    boot: probe.boot() ?? null,
    ns: probe.pidNamespace() ?? null,
    start: probe.startTime(process.pid) ?? null,
    instance: randomUUID(),
  }
}
function parse(text: string): Owner | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const text_ = (x: unknown) => x === null || typeof x === 'string'
  if (
    Object.keys(v).sort().join(',') !==
      'boot,host,instance,ns,pid,start,version' ||
    v.version !== 2 ||
    !Number.isSafeInteger(v.pid) ||
    (v.pid as number) < 1 ||
    typeof v.host !== 'string' ||
    typeof v.instance !== 'string' ||
    !text_(v.boot) ||
    !text_(v.ns) ||
    !text_(v.start)
  )
    return undefined
  return v as Owner
}
/**
 * True only when the recorded owner certainly cannot be running: same host and
 * PID namespace, and either a different boot, a missing PID or a reused PID.
 * Legacy PID-only locks and every ambiguous case stay locked.
 */
function stale(owner: Owner | undefined, probe: LockProbe): boolean {
  if (!owner || owner.host !== probe.hostname()) return false
  const boot = probe.boot() ?? null
  if (owner.boot !== boot) return owner.boot !== null && boot !== null
  if (owner.ns !== (probe.pidNamespace() ?? null)) return false
  if (!probe.alive(owner.pid)) return true
  const start = probe.startTime(owner.pid)
  return owner.start !== null && start !== undefined && start !== owner.start
}
function readLock(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.nlink !== 1 || stat.size > 4096) return undefined
  return readFileSync(path, 'utf8')
}
function syncDirectory(path: string) {
  const fd = openSync(dirname(path), 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function writeNew(path: string, owner: Owner) {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(owner))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Exclusive queue ownership. A lock left by a crashed owner is taken over only
 * when that owner certainly cannot be running; a live owner is never displaced.
 * Throws the original EEXIST error whenever ownership is refused.
 */
export function acquireQueueLock(
  path: string,
  probe: LockProbe = systemLockProbe,
): { recovered: boolean } {
  const owner = describe(probe)
  try {
    writeNew(path, owner)
    return { recovered: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const seen = readLock(path)
    if (seen === undefined || !stale(parse(seen), probe)) throw error
    // One recoverer at a time; it re-reads the lock so a concurrent winner is kept.
    const mutex = openSync(path + '.recover', 'wx', 0o600)
    try {
      if (readLock(path) !== seen) throw error
      const candidate = `${path}.${owner.instance}`
      writeNew(candidate, owner)
      renameSync(candidate, path)
      syncDirectory(path)
    } finally {
      closeSync(mutex)
      unlinkSync(path + '.recover')
    }
    return { recovered: true }
  }
}
