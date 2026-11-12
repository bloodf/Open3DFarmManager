import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// POSIX only. Automatic takeover needs Linux identities (/proc, machine and boot
// IDs); elsewhere every leftover lock fails closed for operator review.

/** Host facts used to decide whether a lock owner can still be running. */
export interface LockProbe {
  hostname(): string
  /** Stable machine identity (/etc/machine-id); undefined when unavailable. */
  machineId(): string | undefined
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
const firstLine = (path: string) =>
  optional(() => readFileSync(path, 'utf8').trim() || undefined)
export const systemLockProbe: LockProbe = {
  hostname,
  machineId: () =>
    firstLine('/etc/machine-id') ?? firstLine('/var/lib/dbus/machine-id'),
  boot: () => firstLine('/proc/sys/kernel/random/boot_id'),
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
  machine: string | null
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
    machine: probe.machineId() ?? null,
    boot: probe.boot() ?? null,
    ns: probe.pidNamespace() ?? null,
    start: probe.startTime(process.pid) ?? null,
    instance: randomUUID(),
  }
}
function parse(text: string | undefined): Owner | undefined {
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const nullable = (x: unknown) => x === null || typeof x === 'string'
  if (
    Object.keys(v).sort().join(',') !==
      'boot,host,instance,machine,ns,pid,start,version' ||
    v.version !== 2 ||
    !Number.isSafeInteger(v.pid) ||
    (v.pid as number) < 1 ||
    typeof v.host !== 'string' ||
    typeof v.instance !== 'string' ||
    !nullable(v.machine) ||
    !nullable(v.boot) ||
    !nullable(v.ns) ||
    !nullable(v.start)
  )
    return undefined
  return v as Owner
}
/**
 * True only when the recorded owner certainly cannot be running: same host,
 * machine and PID namespace with known identities, and either a different boot,
 * a missing PID or a reused PID. Legacy and ambiguous owners stay locked.
 */
function stale(owner: Owner | undefined, probe: LockProbe): boolean {
  if (!owner || owner.host !== probe.hostname()) return false
  const machine = probe.machineId() ?? null
  if (owner.machine === null || machine === null || owner.machine !== machine)
    return false
  const boot = probe.boot() ?? null
  if (owner.boot === null || boot === null) return false
  if (owner.boot !== boot) return true
  if (owner.ns === null || owner.ns !== (probe.pidNamespace() ?? null))
    return false
  if (!probe.alive(owner.pid)) return true
  const start = probe.startTime(owner.pid)
  return owner.start !== null && start !== undefined && start !== owner.start
}
/** Private regular single-link file read through a no-follow descriptor. */
function readPrivate(path: string): string | undefined {
  let fd: number
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch {
    return undefined
  }
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      return undefined
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}
function syncDirectory(path: string) {
  const fd = openSync(dirname(path), 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function writeCandidate(path: string, owner: Owner) {
  const candidate = `${path}.${owner.instance}`
  const fd = openSync(candidate, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(owner))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return candidate
}
/**
 * Publishes a complete owner record without replacing anything: write and fsync
 * a unique candidate, then hard-link it into place (EEXIST if present). A crash
 * can leave only a candidate, never an empty lock.
 */
function writeNew(path: string, owner: Owner) {
  const candidate = writeCandidate(path, owner)
  try {
    linkSync(candidate, path)
  } finally {
    unlinkSync(candidate)
  }
  syncDirectory(path)
}
const ignore = (action: () => void) => {
  try {
    action()
  } catch {
    // Best-effort removal of leftovers.
  }
}
const ours = (path: string, owner: Owner) =>
  parse(readPrivate(path))?.instance === owner.instance
/** Removes a lock or mutex only while it still holds this instance's record. */
function release(path: string, owner: Owner) {
  if (!ours(path, owner)) return
  unlinkSync(path)
  syncDirectory(path)
}
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Exclusive queue ownership. A lock left by a crashed owner is taken over only
 * when that owner certainly cannot be running; a live owner is never displaced.
 * Throws the original EEXIST error whenever ownership is refused. The queue
 * directory must be on a local filesystem.
 *
 * Takeover holds `<lock>.recover`. A leftover recovery mutex is never taken
 * over automatically: it fails closed for operator review.
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
    const seen = readPrivate(path)
    if (seen === undefined || !stale(parse(seen), probe)) throw error
    const mutex = path + '.recover'
    try {
      writeNew(mutex, owner)
    } catch {
      throw error
    }
    try {
      // Re-read under the mutex so a concurrent winner is kept.
      if (readPrivate(path) !== seen) throw error
      // Candidates left by crashed writers (`<lock>.<uuid>`, `<lock>.recover.<uuid>`).
      const leftover = new RegExp(
        `^${escapeRegExp(basename(path))}(\\.recover)?\\.[0-9a-f-]{36}$`,
      )
      for (const entry of readdirSync(dirname(path)))
        if (leftover.test(entry))
          ignore(() => unlinkSync(join(dirname(path), entry)))
      const candidate = writeCandidate(path, owner)
      renameSync(candidate, path)
      try {
        syncDirectory(path)
      } catch (syncError) {
        // Not durably ours: give the lock back rather than hold it unreported.
        ignore(() => release(path, owner))
        throw syncError
      }
    } finally {
      release(mutex, owner)
    }
    return { recovered: true }
  }
}
