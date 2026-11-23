// SPDX-License-Identifier: MIT
import { Buffer } from 'node:buffer'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs'
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rmdir,
  type FileHandle,
} from 'node:fs/promises'
import {
  BlockList,
  createServer,
  isIP,
  type AddressInfo,
  type Socket,
} from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  createRecordReader,
  HelperFailure,
  readAURecord,
} from './record-reader.ts'

const SUPERVISOR_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_RTSP_HELPER_BIN_DIR = resolve(SUPERVISOR_DIR, '../bin')
export const DEFAULT_RTSP_HELPER_PATH = join(
  DEFAULT_RTSP_HELPER_BIN_DIR,
  'rtsp-ingest',
)
export const DEFAULT_RTSP_FIXTURE_PATH = join(
  DEFAULT_RTSP_HELPER_BIN_DIR,
  'rtspfixture',
)

export type RtspHelperStatus = Readonly<
  | {
      available: true
      helperAvailable: true
      status: 'available'
      reason?: undefined
      sha256: string
      message: string
    }
  | {
      available: false
      helperAvailable: false
      status: 'unavailable'
      reason: 'helper-unavailable'
      sha256?: undefined
      message: string
    }
>

const UNAVAILABLE_HELPER_STATUS: RtspHelperStatus = Object.freeze({
  available: false,
  helperAvailable: false,
  status: 'unavailable',
  reason: 'helper-unavailable',
  message: 'RTSP camera unavailable: rtsp-ingest helper is unavailable',
})

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

export function getRtspHelperStatusSync(
  executable?: Partial<HelperExecutable> | null,
): RtspHelperStatus {
  const executablePath = executable?.path ?? DEFAULT_RTSP_HELPER_PATH
  const expectedHash = executable?.sha256
  if (
    process.platform === 'win32' ||
    typeof executablePath !== 'string' ||
    !isAbsolute(executablePath) ||
    (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash))
  ) {
    return UNAVAILABLE_HELPER_STATUS
  }
  let fd: number | undefined
  try {
    if (realpathSync(executablePath) !== executablePath) {
      return UNAVAILABLE_HELPER_STATUS
    }
    const original = lstatSync(executablePath, { bigint: true })
    if (
      !original.isFile() ||
      (original.mode & 0o111n) === 0n ||
      original.size <= 0n
    ) {
      return UNAVAILABLE_HELPER_STATUS
    }
    fd = openSync(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd, { bigint: true })
    if (!sameFile(original, opened)) {
      return UNAVAILABLE_HELPER_STATUS
    }
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(65_536)
    let hashed = 0n
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      hashed += BigInt(bytesRead)
      if (hashed > opened.size) return UNAVAILABLE_HELPER_STATUS
      hash.update(chunk.subarray(0, bytesRead))
    }
    const finalOpened = fstatSync(fd, { bigint: true })
    const finalPath = lstatSync(executablePath, { bigint: true })
    if (
      hashed !== opened.size ||
      !sameFile(opened, finalOpened) ||
      !sameFile(opened, finalPath)
    ) {
      return UNAVAILABLE_HELPER_STATUS
    }
    const sha256 = hash.digest('hex')
    if (expectedHash !== undefined && sha256 !== expectedHash) {
      return UNAVAILABLE_HELPER_STATUS
    }
    return Object.freeze({
      available: true,
      helperAvailable: true,
      status: 'available',
      sha256,
      message: 'RTSP camera helper is available',
    })
  } catch {
    return UNAVAILABLE_HELPER_STATUS
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* Best-effort close. */
      }
    }
  }
}

export async function checkRtspHelperStatus(
  executable?: Partial<HelperExecutable> | null,
): Promise<RtspHelperStatus> {
  return getRtspHelperStatusSync(executable)
}

export type NodeRtspFallbackInstance = Readonly<{
  backend: 'node-fallback'
  host: '127.0.0.1'
  port: number
  path: string
  url: string
  helperStatus: RtspHelperStatus
  close(): Promise<void>
}>

export async function startNodeRtspFallbackServer(
  options: {
    path?: string
    packetsPerPlay?: number
    helperStatus?: RtspHelperStatus
  } = {},
): Promise<NodeRtspFallbackInstance> {
  const rtspPath =
    typeof options.path === 'string' && options.path.startsWith('/')
      ? options.path
      : '/test'
  const packetsPerPlay =
    typeof options.packetsPerPlay === 'number' &&
    Number.isInteger(options.packetsPerPlay) &&
    options.packetsPerPlay >= 1 &&
    options.packetsPerPlay <= 120
      ? options.packetsPerPlay
      : 12
  const helperStatus = options.helperStatus ?? UNAVAILABLE_HELPER_STATUS
  const sdp = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=OpenFarm RTSP Node Fallback',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    'm=video 0 RTP/AVP 96',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f;sprop-parameter-sets=Z0LgH6o=,aM4GAA==',
    'a=control:trackID=0',
    '',
  ].join('\r\n')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      if (buffer.length > 65_536) {
        socket.destroy()
        return
      }
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) break
        const request = buffer.slice(0, end)
        buffer = buffer.slice(end + 4)
        const firstLine = request.split('\r\n')[0] ?? ''
        const [method = '', target = ''] = firstLine.split(' ')
        const cseq = /^CSeq:\s*(\d+)/im.exec(request)?.[1] ?? '1'
        const reply = (status: string, headers: string[] = [], body = '') => {
          const lines = [
            `RTSP/1.0 ${status}`,
            `CSeq: ${cseq}`,
            ...headers,
            `Content-Length: ${Buffer.byteLength(body, 'latin1')}`,
            '',
            body,
          ]
          socket.write(lines.join('\r\n'), 'latin1')
        }
        let pathname = rtspPath
        try {
          if (target.startsWith('rtsp://')) {
            pathname = new URL(target).pathname
          }
        } catch {
          reply('400 Bad Request')
          continue
        }
        if (method === 'OPTIONS') {
          reply('200 OK', ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN'])
        } else if (method === 'DESCRIBE') {
          if (pathname !== rtspPath) {
            reply('404 Not Found')
          } else {
            reply('200 OK', ['Content-Type: application/sdp'], sdp)
          }
        } else if (method === 'SETUP') {
          reply('200 OK', [
            'Transport: RTP/AVP/TCP;unicast;interleaved=0-1',
            'Session: nodefallback1;timeout=60',
          ])
        } else if (method === 'PLAY') {
          reply('200 OK', ['Session: nodefallback1'])
          const nal = Buffer.from([0x65, 0x88, 0x84, 0x21, 0xa0])
          const frames: Buffer[] = []
          for (let seq = 0; seq < packetsPerPlay; seq++) {
            const rtp = Buffer.alloc(12 + nal.length)
            rtp[0] = 0x80
            rtp[1] = 0x80 | 96
            rtp.writeUInt16BE((seq + 1) & 0xffff, 2)
            rtp.writeUInt32BE((seq * 3000) >>> 0, 4)
            rtp.writeUInt32BE(0x12345678, 8)
            nal.copy(rtp, 12)
            const interleaved = Buffer.alloc(4 + rtp.length)
            interleaved[0] = 0x24
            interleaved[1] = 0
            interleaved.writeUInt16BE(rtp.length, 2)
            rtp.copy(interleaved, 4)
            frames.push(interleaved)
          }
          socket.write(Buffer.concat(frames))
        } else if (method === 'TEARDOWN') {
          reply('200 OK', ['Session: nodefallback1'])
        } else {
          reply('405 Method Not Allowed')
        }
      }
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const port = (server.address() as AddressInfo).port
  let closed = false
  return Object.freeze({
    backend: 'node-fallback' as const,
    host: '127.0.0.1' as const,
    port,
    path: rtspPath,
    url: `rtsp://127.0.0.1:${port}${rtspPath}`,
    helperStatus,
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      )
    },
  })
}

export async function startRtspCameraMock(
  options: {
    helperExecutable?: Partial<HelperExecutable> | null
    path?: string
    packetsPerPlay?: number
  } = {},
): Promise<NodeRtspFallbackInstance> {
  const helperStatus = getRtspHelperStatusSync(options.helperExecutable)
  return startNodeRtspFallbackServer({
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.packetsPerPlay !== undefined
      ? { packetsPerPlay: options.packetsPerPlay }
      : {}),
    helperStatus,
  })
}
