// SPDX-License-Identifier: MIT
import { Buffer } from 'node:buffer'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, fstatSync, lstatSync, type BigIntStats } from 'node:fs'
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rmdir,
  type FileHandle,
} from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Duplex } from 'node:stream'
import {
  createRecordReader,
  HelperFailure,
  readAURecord,
} from './record-reader.ts'

export type HelperExecutable = Readonly<{ path: string; sha256: string }>
export type LocalDestination = Readonly<{
  address: string
  port: number
  path: string
}>
type HelperAU = Awaited<ReturnType<typeof readAURecord>>
export type HelperSource = AsyncIterable<HelperAU> & {
  /** Actual owned child PID, available before the first credit; never source authority. */
  readonly pid: number
  readonly closed: Promise<void>
  stop(): Promise<void>
}
export type HelperSourceOptions = {
  executable: HelperExecutable
  sourceHandle: string
  resolveLocal(handle: string): LocalDestination | undefined
  signal: AbortSignal
  expiresAtMonoMs: number
  generation: number
  /** Current caller binding only, never a source authority grant.
   * Revocation must also synchronously abort or stop this owned lifecycle. */
  isAdmitted(generation: number): boolean
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}

function validDestination(destination: LocalDestination): boolean {
  const { address, port, path } = destination
  if (
    typeof address !== 'string' ||
    address.includes('%') ||
    typeof path !== 'string' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[?#@\\\p{Cc}]/u.test(path) ||
    Buffer.byteLength(path) > 1024 ||
    Buffer.from(path).toString('utf8') !== path
  )
    return false
  const family = isIP(address)
  if (family === 0) return false
  const denied = new BlockList()
  if (family === 4) {
    denied.addAddress('0.0.0.0', 'ipv4')
    denied.addAddress('255.255.255.255', 'ipv4')
    denied.addSubnet('224.0.0.0', 4, 'ipv4')
  } else {
    denied.addAddress('::', 'ipv6')
    denied.addSubnet('ff00::', 8, 'ipv6')
    // BlockList maps IPv4 inputs into this range, so apply it only to IPv6 input.
    denied.addSubnet('::ffff:0:0', 96, 'ipv6')
  }
  return !denied.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export async function openHelperSource(
  options: HelperSourceOptions,
): Promise<HelperSource> {
  // Snapshot every trusted input and function reference before invoking user code.
  const executablePath = options.executable.path
  const executableHash = options.executable.sha256
  const sourceHandle = options.sourceHandle
  const resolveLocal = options.resolveLocal
  const signal = options.signal
  const expiresAt = options.expiresAtMonoMs
  const generation = options.generation
  const isAdmitted = options.isAdmitted
  const startedAt = performance.now()
  if (
    process.platform === 'win32' ||
    typeof executablePath !== 'string' ||
    !isAbsolute(executablePath) ||
    typeof executableHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(executableHash) ||
    typeof sourceHandle !== 'string' ||
    sourceHandle.length === 0 ||
    sourceHandle.length > 1024 ||
    typeof resolveLocal !== 'function' ||
    typeof isAdmitted !== 'function' ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= startedAt ||
    expiresAt - startedAt > 30_000
  ) {
    throw new HelperFailure('HELPER_OPTIONS')
  }

  let state: 'opening' | 'running' | 'stopping' | 'closed' = 'opening'
  let failure: HelperFailure | undefined
  let child: ChildProcess | undefined
  let binary: FileHandle | undefined
  let directory: string | undefined
  let reader: ReturnType<typeof createRecordReader> | undefined
  let control: Duplex | undefined
  let operationDeadline = Infinity
  let openingDone = false
  let exitObserved = false
  let closeObserved = false
  let finishing = false
  let terminateTimer: ReturnType<typeof setTimeout> | undefined
  let reapTimer: ReturnType<typeof setTimeout> | undefined
  const stopped = new AbortController()
  let resolveClosed: () => void = () => {}
  let rejectClosed: (error: HelperFailure) => void = () => {}
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve
    rejectClosed = reject
  })
  // The caller still receives the original rejecting promise. No unhandled cleanup rejection.
  void closed.catch(() => {})

  const finishIfReaped = (): void => {
    if (
      state !== 'stopping' ||
      !openingDone ||
      finishing ||
      (child && (!exitObserved || !closeObserved))
    )
      return
    finishing = true
    clearTimeout(terminateTimer)
    clearTimeout(reapTimer)
    void (async () => {
      let cleanupFailed = false
      if (binary) {
        try {
          await binary.close()
        } catch {
          cleanupFailed = true
        }
        binary = undefined
      }
      if (directory) {
        try {
          await rmdir(directory)
        } catch {
          cleanupFailed = true
        }
        directory = undefined
      }
      signal.removeEventListener('abort', onAbort)
      clearTimeout(leaseTimer)
      state = 'closed'
      if (cleanupFailed)
        rejectClosed(new HelperFailure('HELPER_CLEANUP', child?.pid))
      else resolveClosed()
    })()
  }

  const killOwned = (which: NodeJS.Signals): void => {
    if (!child?.pid || exitObserved) return
    try {
      process.kill(-child.pid, which)
    } catch (error: unknown) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ESRCH'
      )) {
        failure ??= new HelperFailure('HELPER_REAP', child.pid)
      }
    }
  }

  const beginStop = (reason?: HelperFailure): void => {
    if (state === 'closed' || state === 'stopping') return
    failure = reason
    state = 'stopping'
    stopped.abort()
    reader?.stop()
    child?.stdin?.destroy()
    control?.destroy()
    child?.stdout?.destroy()
    child?.stderr?.destroy()
    killOwned('SIGTERM')
    if (child && !exitObserved) {
      terminateTimer = setTimeout(() => killOwned('SIGKILL'), 250)
    }
    if (child && (!exitObserved || !closeObserved)) {
      // Diagnostic deadline, not a claim of bounded OS reap latency. Listeners stay attached.
      reapTimer = setTimeout(
        () => rejectClosed(new HelperFailure('HELPER_REAP', child?.pid)),
        2_000,
      )
    }
    finishIfReaped()
  }
  const onAbort = (): void => beginStop(new HelperFailure('HELPER_CANCELED'))
  const leaseTimer = setTimeout(
    () => beginStop(new HelperFailure('HELPER_LEASE')),
    expiresAt - startedAt,
  )
  signal.addEventListener('abort', onAbort, { once: true })

  const checkOwned = (): void => {
    if (state === 'stopping' || state === 'closed')
      throw failure ?? new HelperFailure('HELPER_CANCELED')
    if (signal.aborted) throw new HelperFailure('HELPER_CANCELED')
    const now = performance.now()
    if (now >= expiresAt) throw new HelperFailure('HELPER_LEASE')
    if (now >= operationDeadline) throw new HelperFailure('HELPER_TIMEOUT')
    if (
      child &&
      (exitObserved ||
        closeObserved ||
        child.exitCode !== null ||
        child.signalCode !== null)
    ) {
      throw new HelperFailure('HELPER_EXIT')
    }
  }
  const checkBinding = (): void => {
    checkOwned()
    let admitted: boolean
    try {
      admitted = isAdmitted(generation)
    } catch {
      throw new HelperFailure('HELPER_BINDING')
    }
    // User code may synchronously abort, stop, revoke or mutate its input objects.
    checkOwned()
    if (admitted !== true) throw new HelperFailure('HELPER_BINDING')
  }
  const untilStopped = async <T>(operation: Promise<T>): Promise<T> => {
    if (stopped.signal.aborted)
      throw failure ?? new HelperFailure('HELPER_CANCELED')
    let cancel: () => void = () => {}
    const canceled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(failure ?? new HelperFailure('HELPER_CANCELED'))
      stopped.signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      return await Promise.race([operation, canceled])
    } finally {
      stopped.signal.removeEventListener('abort', cancel)
    }
  }

  let iteratorTaken = false
  let pendingNext = false
  let epoch = 0
  let epochUnits = 0
  let epochBytes = 0
  let leaseBytes = 0
  const source: HelperSource = {
    get pid() {
      const pid = child?.pid
      if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0) {
        throw new HelperFailure('HELPER_SPAWN')
      }
      return pid
    },
    closed,
    stop() {
      beginStop()
      return closed
    },
    [Symbol.asyncIterator]() {
      if (iteratorTaken) {
        const error = new HelperFailure('HELPER_PRESSURE')
        beginStop(error)
        throw error
      }
      iteratorTaken = true
      return {
        async next(): Promise<IteratorResult<HelperAU>> {
          if (pendingNext) {
            const error = new HelperFailure('HELPER_PRESSURE')
            beginStop(error)
            throw error
          }
          if (state === 'stopping' || state === 'closed') {
            await closed
            if (failure) throw failure
            return { done: true, value: undefined }
          }
          pendingNext = true
          const operationStarted = performance.now()
          operationDeadline = Math.min(expiresAt, operationStarted + 2_000)
          const operationTimer = setTimeout(
            () =>
              beginStop(
                new HelperFailure(
                  operationDeadline === expiresAt
                    ? 'HELPER_LEASE'
                    : 'HELPER_TIMEOUT',
                ),
              ),
            Math.max(0, operationDeadline - operationStarted),
          )
          try {
            checkBinding()
            if (
              state !== 'running' ||
              !reader ||
              !control ||
              control.destroyed
            ) {
              throw new HelperFailure('HELPER_IO')
            }
            // Set demand before granting its single credit. No speculative next/prefetch.
            const record = readAURecord(reader, stopped.signal)
            void record.catch(() => {})
            checkBinding()
            await untilStopped(
              new Promise<void>((resolve, reject) => {
                control?.write(Buffer.from([1]), (error?: Error | null) => {
                  if (error) reject(new HelperFailure('HELPER_IO'))
                  else resolve()
                })
              }),
            )
            checkBinding()
            const unit = await record
            checkBinding()
            const second = Math.floor((performance.now() - startedAt) / 1_000)
            if (second !== epoch) {
              epoch = second
              epochUnits = 0
              epochBytes = 0
            }
            const bytes = unit.data.byteLength + 16
            epochUnits += 1
            epochBytes += bytes
            leaseBytes += bytes
            if (
              epochUnits > 30 ||
              epochBytes > 1_048_576 ||
              leaseBytes > 16_777_216
            ) {
              throw new HelperFailure('HELPER_PRESSURE')
            }
            checkOwned()
            return { done: false, value: unit }
          } catch (error: unknown) {
            beginStop(
              error instanceof HelperFailure
                ? error
                : new HelperFailure('HELPER_IO'),
            )
            await closed
            if (failure) throw failure
            return { done: true, value: undefined }
          } finally {
            clearTimeout(operationTimer)
            operationDeadline = Infinity
            pendingNext = false
          }
        },
        async return(): Promise<IteratorResult<HelperAU>> {
          beginStop()
          await closed
          return { done: true, value: undefined }
        },
      }
    },
  }

  try {
    checkBinding()
    let resolved: LocalDestination | undefined
    try {
      resolved = resolveLocal(sourceHandle)
    } catch {
      throw new HelperFailure('HELPER_DESTINATION')
    }
    // Snapshot result primitives immediately, before any await or further callback.
    const destination =
      resolved &&
      Object.freeze({
        address: resolved.address,
        port: resolved.port,
        path: resolved.path,
      })
    checkBinding()
    if (!destination || !validDestination(destination))
      throw new HelperFailure('HELPER_DESTINATION')
    if ((await realpath(executablePath)) !== executablePath)
      throw new HelperFailure('HELPER_EXECUTABLE')
    checkBinding()
    const original = await lstat(executablePath, { bigint: true })
    checkBinding()
    if (!original.isFile() || (original.mode & 0o111n) === 0n)
      throw new HelperFailure('HELPER_EXECUTABLE')
    binary = await open(
      executablePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    checkBinding()
    const opened = await binary.stat({ bigint: true })
    checkBinding()
    if (!sameFile(original, opened))
      throw new HelperFailure('HELPER_EXECUTABLE')
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafeSlow(65_536)
    let hashed = 0n
    for (;;) {
      const { bytesRead } = await binary.read(chunk, 0, chunk.length, null)
      checkBinding()
      if (bytesRead === 0) break
      hashed += BigInt(bytesRead)
      if (hashed > opened.size) throw new HelperFailure('HELPER_EXECUTABLE')
      hash.update(chunk.subarray(0, bytesRead))
    }
    if (hashed !== opened.size || hash.digest('hex') !== executableHash) {
      throw new HelperFailure('HELPER_EXECUTABLE')
    }
    directory = await mkdtemp(join(tmpdir(), 'rtsp-helper-'))
    checkBinding()
    // No external callback or await between final identity check and spawn.
    const finalOpened = fstatSync(binary.fd, { bigint: true })
    const finalPath = lstatSync(executablePath, { bigint: true })
    checkOwned()
    if (!sameFile(opened, finalOpened) || !sameFile(opened, finalPath)) {
      throw new HelperFailure('HELPER_EXECUTABLE')
    }
    // Portable POSIX spawn has no fd-exec. A path replacement after this check
    // remains a TOCTOU limit; the attested artifact and its ancestors must be trusted.
    child = spawn(executablePath, [], {
      shell: false,
      detached: true,
      cwd: directory,
      env: { LANG: 'C', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    const ownedChild = child
    const spawned = new Promise<void>((resolve, reject) => {
      ownedChild.once('spawn', resolve)
      ownedChild.on('error', () => {
        // Failed spawn has no process to reap and does not emit exit.
        if (!ownedChild.pid) exitObserved = true
        const error = new HelperFailure('HELPER_SPAWN')
        reject(error)
        beginStop(error)
      })
    })
    ownedChild.once('exit', () => {
      exitObserved = true
      beginStop(new HelperFailure('HELPER_EXIT'))
      finishIfReaped()
    })
    ownedChild.once('close', () => {
      closeObserved = true
      beginStop(new HelperFailure('HELPER_EXIT'))
      finishIfReaped()
    })
    void spawned.catch(() => {})
    const fd3 = ownedChild.stdio[3]
    if (
      !ownedChild.stdin ||
      !ownedChild.stdout ||
      !ownedChild.stderr ||
      !(fd3 instanceof Duplex)
    ) {
      throw new HelperFailure('HELPER_IO')
    }
    control = fd3
    for (const pipe of [ownedChild.stdin, control]) {
      pipe.on('error', () => beginStop(new HelperFailure('HELPER_IO')))
    }
    reader = createRecordReader(ownedChild.stdout, beginStop)
    let stderrTotal = 0
    let stderrRetained = 0
    const stderr = Buffer.alloc(4_096)
    ownedChild.stderr.on('error', () =>
      beginStop(new HelperFailure('HELPER_IO')),
    )
    ownedChild.stderr.on('data', (data: unknown) => {
      if (state === 'stopping' || state === 'closed') return
      if (!Buffer.isBuffer(data) || data.length > 16_384 - stderrTotal) {
        beginStop(new HelperFailure('HELPER_STDERR'))
        return
      }
      stderrTotal += data.length
      stderrRetained += data.copy(
        stderr,
        stderrRetained,
        0,
        Math.min(data.length, 4_096 - stderrRetained),
      )
    })
    checkBinding()
    await untilStopped(spawned)
    checkBinding()
    const leaseMs = Math.floor(expiresAt - performance.now())
    if (leaseMs < 1 || leaseMs > 30_000) throw new HelperFailure('HELPER_LEASE')
    const config = Buffer.from(
      JSON.stringify({ version: 1, ...destination, leaseMs }),
    )
    if (config.length > 2_048) throw new HelperFailure('HELPER_DESTINATION')
    checkOwned()
    await untilStopped(
      new Promise<void>((resolve, reject) => {
        ownedChild.stdin?.end(config, (error?: Error | null) => {
          config.fill(0)
          if (error) reject(new HelperFailure('HELPER_IO'))
          else resolve()
        })
      }),
    )
    checkBinding()
    state = 'running'
    return Object.freeze(source)
  } catch (error: unknown) {
    const sanitized =
      error instanceof HelperFailure
        ? error
        : new HelperFailure('HELPER_EXECUTABLE')
    beginStop(sanitized)
    openingDone = true
    finishIfReaped()
    await closed
    throw failure ?? sanitized
  } finally {
    openingDone = true
    finishIfReaped()
  }
}
