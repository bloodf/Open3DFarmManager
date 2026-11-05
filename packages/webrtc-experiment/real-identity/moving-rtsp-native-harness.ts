// SPDX-License-Identifier: MIT
// Finite test transport only. Receipt verification is not an AnnexB parser or authority.
import { createHash } from 'node:crypto'

export type MovingPreflightRecord = Readonly<{
  rawSHA256: string
  canonicalSHA256: string
  canonicalBytes: number
  nalCount: number
  packetCount: number
}>
export type MovingPreflight = Readonly<{
  fixtureSHA256: string
  records: readonly MovingPreflightRecord[]
}>
export type MovingUnit = Readonly<{
  data: Uint8Array
  keyframe: boolean
  timestampUs: number
}>
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const hash = (value: string) => /^[a-f0-9]{64}$/.test(value)

/** The caller supplies fresh receipts from the reviewed maintained Go parser.
 * No receipt means no playback. These metadata checks never parse H264 themselves.
 */
export function validateMovingPreflight(
  units: readonly MovingUnit[],
  receipt: MovingPreflight,
  expectedFixtureSHA256: string,
): readonly MovingPreflightRecord[] {
  if (
    !hash(expectedFixtureSHA256) ||
    receipt.fixtureSHA256 !== expectedFixtureSHA256 ||
    units.length !== 30 ||
    receipt.records.length !== 30
  )
    throw Error('MOVING_PREFLIGHT')
  let rawTotal = 0,
    canonicalTotal = 0
  const rows = units.map((unit, index) => {
    const row = receipt.records[index]!
    if (
      !(unit.data instanceof Uint8Array) ||
      unit.data.buffer instanceof SharedArrayBuffer ||
      unit.data.byteLength < 1 ||
      unit.data.byteLength > 262144 ||
      unit.keyframe !== true ||
      unit.timestampUs !== index * 100000 ||
      !hash(row.rawSHA256) ||
      !hash(row.canonicalSHA256) ||
      sha256(unit.data) !== row.rawSHA256 ||
      !Number.isSafeInteger(row.canonicalBytes) ||
      row.canonicalBytes < 1 ||
      row.canonicalBytes > 262144 ||
      !Number.isInteger(row.nalCount) ||
      row.nalCount < 1 ||
      row.nalCount > 8 ||
      !Number.isInteger(row.packetCount) ||
      row.packetCount < row.nalCount ||
      row.packetCount > 8
    )
      throw Error('MOVING_PREFLIGHT')
    rawTotal += unit.data.byteLength
    canonicalTotal += row.canonicalBytes
    return Object.freeze({ ...row })
  })
  if (rawTotal > 4194304 || canonicalTotal > 4194304)
    throw Error('MOVING_PREFLIGHT')
  for (let index = 0; index < rows.length; index++)
    if (
      rows
        .slice(index, index + 11)
        .reduce((n, row) => n + row.canonicalBytes + 16, 0) > 1048576
    )
      throw Error('MOVING_PREFLIGHT_WINDOW')
  return Object.freeze(rows)
}

export type MovingPumpOptions = Readonly<{
  units: readonly MovingUnit[]
  preflight: MovingPreflight
  fixtureSHA256: string
  iterator: AsyncIterator<MovingUnit>
  write(unit: MovingUnit): Promise<void>
  send(unit: MovingUnit): Promise<boolean>
  signal: AbortSignal
  /** Fixed parent-clock bound captured before admitting the native peers, never reset. */
  deadlineMonoMs: number
  current(): boolean
  now?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}>

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      reject(Error('MOVING_ABORTED'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
}

/** One pending next()/credit and one write at a time. Credit submission is NOT
 * acknowledgement that Go consumed credit. A pressure failure remains terminal.
 */
export async function pumpMovingRtspUnits(options: MovingPumpOptions) {
  const rows = validateMovingPreflight(
    options.units,
    options.preflight,
    options.fixtureSHA256,
  )
  const now = options.now ?? (() => performance.now())
  const wait = options.wait ?? waitFor
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  const deadline = options.deadlineMonoMs
  const start = now()
  if (
    !Number.isFinite(deadline) ||
    deadline <= start ||
    deadline - start > 5000
  )
    throw Error('MOVING_LEASE')
  let previous = start,
    sent = 0,
    bytes = 0
  const check = () => {
    const current = options.current()
    const stamp = now()
    if (
      signal.aborted ||
      !current ||
      !Number.isFinite(stamp) ||
      stamp < previous ||
      stamp >= deadline
    )
      throw Error('MOVING_LEASE')
    previous = stamp
    return stamp
  }
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, deadline - start),
  )
  let failure: unknown
  const abort = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(Error('MOVING_ABORTED')), {
      once: true,
    })
  })
  void abort.catch(() => {})
  const bounded = <T>(work: Promise<T>) => Promise.race([work, abort])
  let nextSend = start
  try {
    for (let index = 0; index < options.units.length; index++) {
      check()
      // Arm demand first, including while waiting for the next pacing deadline.
      const pending = options.iterator.next().catch((error: unknown) => {
        failure = error
        controller.abort()
        throw error
      })
      void pending.catch(() => {})
      while (check() < nextSend)
        await bounded(
          wait(Math.min(nextSend - now(), deadline - now()), signal),
        )
      check()
      const unit = options.units[index]!,
        row = rows[index]!
      // Reject caller mutation after the all-record preflight.
      if (
        sha256(unit.data) !== row.rawSHA256 ||
        unit.timestampUs !== index * 100000 ||
        unit.keyframe !== true
      )
        throw Error('MOVING_SOURCE_CHANGED')
      await bounded(options.write(unit))
      check()
      const result = await bounded(pending)
      check()
      if (
        result.done ||
        result.value.data.buffer instanceof SharedArrayBuffer ||
        result.value.keyframe !== true ||
        result.value.timestampUs !== index * 100000 ||
        result.value.data.byteLength !== row.canonicalBytes ||
        sha256(result.value.data) !== row.canonicalSHA256
      )
        throw Error('MOVING_HELPER_MISMATCH')
      if ((await bounded(options.send(result.value))) !== true)
        throw Error('MOVING_NATIVE_REJECTED')
      const acceptedAt = check()
      sent++
      bytes += result.value.data.byteLength
      nextSend = acceptedAt + 100
    }
    return Object.freeze({ sent, bytes, elapsedMs: check() - start })
  } catch (error) {
    throw failure ?? error
  } finally {
    clearTimeout(timer)
    controller.abort()
    // Owner stops/reaps the helper and closes the fixture independently; racing
    // a deadline does not establish that an underlying next/write/send settled.
  }
}

export async function disposeMovingResources(
  disposals: readonly (() => Promise<unknown>)[],
) {
  const settled = await Promise.allSettled(
    disposals.map((dispose) => Promise.resolve().then(dispose)),
  )
  const errors = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (errors.length) throw new AggregateError(errors, 'MOVING_CLEANUP')
}

/** RPF1 is output only from the maintained Go preflight executable. The binary
 * cannot attest itself: the caller pins and rechecks its local executable. */
export function decodeMovingPreflight(
  bytes: Uint8Array,
  fixtureSHA256: string,
): MovingPreflight {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    !hash(fixtureSHA256) ||
    data.length !== 8 + 30 * 72 ||
    data.toString('ascii', 0, 4) !== 'RPF1' ||
    data.readUInt16BE(4) !== 30 ||
    data.readUInt16BE(6) !== 0
  )
    throw Error('MOVING_PREFLIGHT_WIRE')
  const records: MovingPreflightRecord[] = []
  for (let index = 0; index < 30; index++) {
    const at = 8 + index * 72
    records.push(
      Object.freeze({
        rawSHA256: data.subarray(at, at + 32).toString('hex'),
        canonicalSHA256: data.subarray(at + 32, at + 64).toString('hex'),
        canonicalBytes: data.readUInt32BE(at + 64),
        nalCount: data.readUInt16BE(at + 68),
        packetCount: data.readUInt16BE(at + 70),
      }),
    )
  }
  return Object.freeze({ fixtureSHA256, records: Object.freeze(records) })
}

type Executable = Readonly<{ path: string; sha256: string }>
export type MovingFixtureProcess = Readonly<{
  input: import('node:stream').Writable
  output: import('node:stream').Readable
  /** Resolves only on successful exit AND stdio closure; rejects abnormal exit. */
  closed: Promise<void>
  stop(): Promise<void>
}>
export type MovingRtspNativeOptions = Readonly<{
  fixture: Executable
  helper: Executable
  port: number
  /** Explicit reviewed controller owns sandbox, stderr caps, PID identity and reap.
   * preflight invokes --preflight; stream invokes the same binary without flags. */
  launchFixture(
    input: Readonly<{
      mode: 'preflight' | 'stream'
      executable: Executable
      signal: AbortSignal
    }>,
  ): Promise<MovingFixtureProcess>
}>

async function attestExecutable(value: Executable) {
  const { open, realpath } = await import('node:fs/promises')
  const { isAbsolute } = await import('node:path')
  const { constants } = await import('node:fs')
  if (
    !isAbsolute(value.path) ||
    !hash(value.sha256) ||
    (await realpath(value.path)) !== value.path
  )
    throw Error('MOVING_EXECUTABLE')
  const file = await open(value.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size < 1n || before.size > 67108864n)
      throw Error('MOVING_EXECUTABLE')
    const digest = createHash('sha256')
    const buffer = Buffer.alloc(65536)
    for (;;) {
      const { bytesRead } = await file.read(buffer)
      if (!bytesRead) break
      digest.update(buffer.subarray(0, bytesRead))
    }
    const after = await file.stat({ bigint: true })
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      digest.digest('hex') !== value.sha256
    )
      throw Error('MOVING_EXECUTABLE')
  } finally {
    await file.close()
  }
}

async function readFixed(
  pipe: import('node:stream').Readable,
  size: number,
  signal: AbortSignal,
  eof: boolean,
): Promise<Buffer> {
  const data = Buffer.alloc(size)
  let offset = 0
  let wake: (() => void) | undefined,
    failed = false
  const notify = () => wake?.()
  const fail = () => {
    failed = true
    notify()
  }
  pipe.pause()
  pipe.on('readable', notify)
  pipe.on('end', notify)
  pipe.on('close', notify)
  pipe.on('error', fail)
  signal.addEventListener('abort', fail, { once: true })
  try {
    for (;;) {
      if (
        failed ||
        signal.aborted ||
        pipe.readableLength > size - offset + (eof ? 1 : 0)
      )
        throw Error('MOVING_PIPE')
      if (offset === size && !eof) return data
      const chunk: unknown = pipe.read(
        Math.min(
          size - offset + (eof ? 1 : 0),
          Math.max(1, pipe.readableLength),
        ),
      )
      if (chunk !== null) {
        if (
          !Buffer.isBuffer(chunk) ||
          chunk.length > size - offset ||
          chunk.length === 0
        )
          throw Error('MOVING_PIPE')
        chunk.copy(data, offset)
        offset += chunk.length
        continue
      }
      if (pipe.readableEnded) {
        if (offset !== size) throw Error('MOVING_PIPE')
        return data
      }
      if (pipe.destroyed) throw Error('MOVING_PIPE')
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = undefined
    }
  } finally {
    signal.removeEventListener('abort', fail)
    pipe.removeListener('readable', notify)
    pipe.removeListener('end', notify)
    pipe.removeListener('close', notify)
    pipe.removeListener('error', fail)
  }
}

/** Explicit manual integration. No default path/pin/controller and no invocation
 * during imports/tests. Requires rebuilt fixture supporting reviewed --preflight. */
export async function runMovingRtspNativePhase(
  options: MovingRtspNativeOptions,
) {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw Error('MOVING_PORT')
  const fixture = Object.freeze({ ...options.fixture }),
    helper = Object.freeze({ ...options.helper })
  const launch = options.launchFixture,
    port = options.port
  await attestExecutable(fixture)
  await attestExecutable(helper)
  const { runFiniteMediaPhase } = await import('./native-media-harness.ts')
  const { writeMovingHeader, writeMovingAU, readMovingSummary } = await import(
    '../../../tools/rtsp-ingest/integration/moving-fixture-input.ts'
  )
  const { openHelperSource } = await import(
    '../../../tools/rtsp-ingest/supervisor/process.ts'
  )
  await runFiniteMediaPhase('native', {
    async prepare(encoded) {
      if (
        encoded.width !== 128 ||
        encoded.height !== 96 ||
        encoded.units.length !== 30
      )
        throw Error('MOVING_ENCODING')
      const units = encoded.units.map((unit) => {
        const data = Buffer.from(unit.data, 'base64')
        if (data.toString('base64') !== unit.data)
          throw Error('MOVING_ENCODING')
        return Object.freeze({
          data,
          keyframe: unit.keyframe,
          timestampUs: unit.timestampUs,
        })
      })
      const preflightAbort = new AbortController(),
        timer = setTimeout(() => preflightAbort.abort(), 5000)
      let checker: MovingFixtureProcess | undefined, receipt: MovingPreflight
      try {
        await attestExecutable(fixture)
        checker = await launch({
          mode: 'preflight',
          executable: fixture,
          signal: preflightAbort.signal,
        })
        void checker.closed.catch(() => preflightAbort.abort())
        await writeMovingHeader(
          checker.input,
          { port, frames: 30 },
          preflightAbort.signal,
        )
        for (const unit of units)
          await writeMovingAU(checker.input, unit, preflightAbort.signal)
        checker.input.end()
        receipt = decodeMovingPreflight(
          await readFixed(checker.output, 2168, preflightAbort.signal, true),
          fixture.sha256,
        )
        await checker.closed
        validateMovingPreflight(units, receipt, fixture.sha256)
      } finally {
        clearTimeout(timer)
        preflightAbort.abort()
        await checker?.stop()
      }
      let source: Awaited<ReturnType<typeof openHelperSource>> | undefined,
        producer: MovingFixtureProcess | undefined
      const owned = new AbortController()
      return {
        async transmit(input) {
          const signal = AbortSignal.any([input.signal, owned.signal])
          const leaseTimer = setTimeout(
            () => owned.abort(),
            Math.max(0, input.deadlineMonoMs - performance.now()),
          )
          try {
            await attestExecutable(fixture)
            producer = await launch({
              mode: 'stream',
              executable: fixture,
              signal,
            })
            void producer.closed.catch(() => owned.abort())
            await writeMovingHeader(
              producer.input,
              { port, frames: 30 },
              signal,
            )
            const ready = await readFixed(producer.output, 8, signal, false)
            if (
              ready.toString('ascii', 0, 4) !== 'RTF2' ||
              ready.readUInt16BE(4) !== port ||
              ready.readUInt16BE(6) !== 30
            )
              throw Error('MOVING_READY')
            source = await openHelperSource({
              executable: helper,
              sourceHandle: 'original-moving-fixture',
              resolveLocal: () => ({
                address: '127.0.0.1',
                port,
                path: '/fixture',
              }),
              signal,
              expiresAtMonoMs: input.deadlineMonoMs,
              generation: 1,
              isAdmitted: () =>
                !signal.aborted && performance.now() < input.deadlineMonoMs,
            })
            const producerInput = producer.input
            await pumpMovingRtspUnits({
              units,
              preflight: receipt,
              fixtureSHA256: fixture.sha256,
              iterator: source[Symbol.asyncIterator](),
              signal,
              deadlineMonoMs: input.deadlineMonoMs,
              current: () => !signal.aborted,
              write: (unit) => writeMovingAU(producerInput, unit, signal),
              send: input.send,
            })
            await source.stop()
            producer.input.end()
            const summary = await readMovingSummary(
              producer.output,
              { frames: 30 },
              signal,
            )
            if (
              summary.canonicalSHA256.some(
                (value, index) =>
                  value !== receipt.records[index]!.canonicalSHA256,
              )
            )
              throw Error('MOVING_SUMMARY_HASH')
            await producer.closed
          } finally {
            clearTimeout(leaseTimer)
          }
        },
        async dispose() {
          owned.abort()
          await disposeMovingResources([
            async () => source?.stop(),
            async () => producer?.stop(),
          ])
        },
      }
    },
  })
}
