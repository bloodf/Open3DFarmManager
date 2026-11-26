import { createHash, randomUUID } from 'node:crypto'
import {
  exchange,
  object,
  requestMayHaveArrived,
  type PhrozenEndpoint,
  type PhrozenReply,
} from './transport.ts'

// Operations for the Revo 14K identity that discovery accepts. Evidence, gaps
// and refusals per model: docs/fullfarmmanager/evidence/phrozen.md.
//
// Wire contract ("SDCP"): CBD SDCP V3.0.0 at
// https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/f977215761ee2e8c6d02ab06a68dc4d2b710a255/SDCP(Smart%20Device%20Control%20Protocol)_V3.0.0_EN.md
// It is the mainboard maker's generic protocol, not a Phrozen document. No
// operation here is confirmed on Phrozen hardware.
//
// Phrozen shows remote printing and monitoring on the Revo (V138):
// https://www.youtube.com/watch?v=ngnSR3nWJGw
// ChituManager network sending, then print:
// https://docs.chitubox.com/en-US/chitu-manager/latest/ui-and-features/network-sending
// ChituManager pause, resume, stop, video and history:
// https://docs.chitubox.com/en-US/chitu-manager/latest/ui-and-features/operations
// Phrozen release notes add streaming to the Revo 14K at V149, after V138:
// https://helpcenter.phrozen3d.com/hc/en-us/articles/6369983852569-Firmware-downloads-and-release-notes
const STREAMING_FIRMWARE = new Set(['V153'])

// SDCP "PrintInfo > Status".
const HOMING = 1
const ACTIVE = [2, 3, 4] // descending, exposing, lifting
const STOPPABLE = [HOMING, 2, 3, 4, 5, 6, 10]
const PAUSED = 6
const STOPPED = 8
const SETTLED = [0, 8, 9] // idle, stopped, complete

// SDCP "Start Printing(Cmd: 128)", Ack Code.
const START_ACKS: Record<number, string> = {
  1: 'printer-busy',
  2: 'file-not-found',
  3: 'file-md5-failed',
  4: 'file-read-failed',
  5: 'resolution-mismatch',
  6: 'unknown-format',
  7: 'model-mismatch',
}
// SDCP "Enable/Disable Video Stream(Cmd: 386)".
const VIDEO_ACKS: Record<number, string> = {
  1: 'stream-limit-reached',
  2: 'camera-missing',
  3: 'camera-error',
}

const CHUNK_BYTES = 1024 * 1024 // SDCP "Send File Interface"
const MAX_FILE_BYTES = 1024 * CHUNK_BYTES // local bound; the spec gives none

export type PhrozenRefusal = { outcome: 'refused'; reason: string }
export type PhrozenUncertain = { outcome: 'uncertain'; reason: string }
export type PhrozenResult<T> =
  ({ outcome: 'confirmed' } & T) | PhrozenRefusal | PhrozenUncertain

/** Last check before a write leaves this process; false sends nothing. */
export type PhrozenWriteGuard = () => boolean

/**
 * One state-changing operation at a time. Shared by every session of one
 * printer, so an uncertain result still holds after a reconnect.
 */
export type PhrozenOperationLock = { busy: boolean; held: boolean }

export type PhrozenTaskUsage = Readonly<{
  board: string
  taskId: string
  /** SDCP TaskStatus; `unsettled` covers "Other", which is not an end state. */
  status: 'completed' | 'exception' | 'stopped' | 'unsettled'
  /** Epoch milliseconds from the printer clock; null when not reported. */
  beginTime: number | null
  endTime: number | null
  printedLayers: number | null
  /**
   * `CurrentLayerTalVolume`, "Total Volume of Printed Layers(ml)" (SDCP
   * Cmd 321). The printer reports it; no source says it is a physical
   * measurement. Null means unknown, and a zero is treated as unknown.
   */
  volumeMl: number | null
}>

const refused = (reason: string): PhrozenRefusal => ({
  outcome: 'refused',
  reason,
})
const uncertain = (reason: string): PhrozenUncertain => ({
  outcome: 'uncertain',
  reason,
})

function job(status: Record<string, unknown>) {
  const current = status.CurrentStatus as number[]
  const info = status.PrintInfo
  if (!info || typeof info !== 'object') return
  const { Status, Filename, TaskId, ErrorNumber } = info as Record<
    string,
    unknown
  >
  if (!Number.isInteger(Status) || !Number.isInteger(ErrorNumber)) return
  return {
    current,
    printing: current.includes(1),
    idle: current.length === 1 && current[0] === 0,
    print: Status as number,
    error: ErrorNumber as number,
    filename: typeof Filename === 'string' ? Filename : '',
    taskId: typeof TaskId === 'string' ? TaskId : '',
  }
}
type Job = NonNullable<ReturnType<typeof job>>

/** The reported job, reduced to what the Connector's command path compares. */
export function phrozenPrintState(status: Record<string, unknown>): {
  state: 'printing' | 'paused' | 'idle' | 'cancelled' | 'unknown'
  taskId: string
} {
  const seen = job(status)
  if (!seen) return { state: 'unknown', taskId: '' }
  const { print, taskId } = seen
  const state =
    print === STOPPED
      ? 'cancelled'
      : seen.printing
        ? print === PAUSED
          ? 'paused'
          : print === HOMING || ACTIVE.includes(print)
            ? 'printing'
            : 'unknown'
        : seen.idle && SETTLED.includes(print)
          ? 'idle'
          : 'unknown'
  return { state, taskId }
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const safeFilename = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) && !name.includes('..')

const seconds = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number) * 1000
    : null

export function createPhrozenOperations(input: {
  endpoint: PhrozenEndpoint
  firmware: string
  readStatus(): Promise<Record<string, unknown>>
  confirmTimeoutMs: number
  pollMs: number
  uploadTimeoutMs: number
  lock?: PhrozenOperationLock | undefined
}) {
  const { endpoint, firmware } = input
  const lock = input.lock ?? { busy: false, held: false }

  /**
   * One state-changing operation at a time. An uncertain result holds every
   * later one until an operator who checked the printer acknowledges it.
   */
  async function exclusive<T>(
    work: () => Promise<PhrozenResult<T>>,
  ): Promise<PhrozenResult<T>> {
    if (lock.held) return refused('uncertain-result-unacknowledged')
    if (lock.busy) return refused('operation-in-progress')
    lock.busy = true
    try {
      const result = await work()
      if (result.outcome === 'uncertain') lock.held = true
      return result
    } finally {
      lock.busy = false
    }
  }

  /** SDCP Cmd 1: the printer's own capability report, read before each use. */
  async function readAttributes() {
    const { ack, pushed } = await exchange(
      endpoint,
      1,
      {},
      {
        topic: 'attributes',
        check: (frame) => object(frame.Attributes),
      },
    )
    if (ack !== 0) throw new Error(`Phrozen denied attributes (Ack ${ack})`)
    return pushed as Record<string, unknown>
  }

  async function gate(
    capability: 'PRINT_CONTROL' | 'FILE_TRANSFER' | 'VIDEO_STREAM',
  ): Promise<PhrozenRefusal | Record<string, unknown>> {
    let attributes: Record<string, unknown>
    try {
      attributes = await readAttributes()
    } catch {
      return refused('attributes-unavailable')
    }
    if (
      attributes.MainboardID !== endpoint.board ||
      attributes.FirmwareVersion !== firmware
    )
      return refused('identity-changed')
    return Array.isArray(attributes.Capabilities) &&
      attributes.Capabilities.includes(capability)
      ? attributes
      : refused('capability-not-reported')
  }
  const isRefusal = (value: object): value is PhrozenRefusal =>
    'outcome' in value && value.outcome === 'refused'

  async function currentJob(): Promise<Job | PhrozenRefusal> {
    try {
      return job(await input.readStatus()) ?? refused('status-incomplete')
    } catch {
      return refused('status-unavailable')
    }
  }

  /** Repeats a read until it shows the expected state. Never resends. */
  async function observe<T>(
    read: () => Promise<T | undefined>,
  ): Promise<T | undefined> {
    const deadline = performance.now() + input.confirmTimeoutMs
    for (;;) {
      try {
        const seen = await read()
        if (seen !== undefined) return seen
      } catch {
        // A failed read says nothing about the command.
      }
      if (performance.now() >= deadline) return
      await new Promise((resolve) => setTimeout(resolve, input.pollMs))
    }
  }

  async function send(
    cmd: number,
    payload: Record<string, unknown>,
    reasons: Record<number, string> = {},
    guard?: PhrozenWriteGuard,
  ): Promise<PhrozenReply | PhrozenRefusal | PhrozenUncertain> {
    try {
      const reply = await exchange(endpoint, cmd, payload, undefined, {
        guard,
      })
      return reply.ack === 0
        ? reply
        : refused(reasons[reply.ack] ?? `printer-ack-${reply.ack}`)
    } catch (error) {
      return requestMayHaveArrived(error)
        ? uncertain('response-lost')
        : refused('not-sent')
    }
  }

  async function command(
    cmd: number,
    payload: Record<string, unknown>,
    refusal: (before: Job) => string | undefined,
    reached: (after: Job, before: Job) => boolean,
    reasons?: Record<number, string>,
    guard?: PhrozenWriteGuard,
  ): Promise<PhrozenResult<{ taskId: string }>> {
    const attributes = await gate('PRINT_CONTROL')
    if (isRefusal(attributes)) return attributes
    const before = await currentJob()
    if ('outcome' in before) return before
    const reason = refusal(before)
    if (reason) return refused(reason)
    const reply = await send(cmd, payload, reasons, guard)
    if ('outcome' in reply) return reply
    const after = await observe(async () => {
      const seen = job(await input.readStatus())
      return seen && reached(seen, before) ? seen : undefined
    })
    return after
      ? { outcome: 'confirmed', taskId: after.taskId }
      : uncertain('state-unconfirmed')
  }

  /** Pause, resume and stop act only on the job the caller has seen. */
  const sameTask = (state: Job, taskId: string) =>
    taskId !== '' && state.taskId === taskId

  /** SDCP Cmd 258. Throws unless the printer returns a well-formed list. */
  async function listFiles() {
    const { ack, data } = await exchange(endpoint, 258, { Url: '/local/' })
    if (ack !== 0 || !Array.isArray(data.FileList))
      throw new Error('Phrozen file list unavailable')
    return data.FileList.map((entry) => object(entry)).flatMap(
      ({ name, type }) =>
        type === 1 && typeof name === 'string' ? [basename(name)] : [],
    )
  }

  async function postChunk(
    form: FormData,
  ): Promise<PhrozenRefusal | PhrozenUncertain | undefined> {
    try {
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/uploadFile/upload`,
        {
          method: 'POST',
          body: form,
          redirect: 'error',
          signal: AbortSignal.timeout(input.uploadTimeoutMs),
        },
      )
      if (!response.ok) {
        await response.body?.cancel()
        return uncertain(`upload-http-${response.status}`)
      }
      const body = object(await response.json())
      if (body.success === true && body.code === '000000') return
      return body.success === false
        ? refused('upload-rejected')
        : uncertain('upload-reply-malformed')
    } catch {
      return uncertain('upload-response-lost')
    }
  }

  return {
    readAttributes,

    /** Clears the hold. Call only after a person has checked the printer. */
    acknowledgeUncertain() {
      lock.held = false
    },

    pause: (taskId: string, guard?: PhrozenWriteGuard) =>
      exclusive(() =>
        command(
          129,
          {},
          (s) =>
            !sameTask(s, taskId)
              ? 'task-mismatch'
              : !s.printing || !ACTIVE.includes(s.print)
                ? 'not-printing'
                : undefined,
          (s) => sameTask(s, taskId) && s.print === PAUSED,
          undefined,
          guard,
        ),
      ),

    resume: (taskId: string, guard?: PhrozenWriteGuard) =>
      exclusive(() =>
        command(
          131,
          {},
          (s) =>
            !sameTask(s, taskId)
              ? 'task-mismatch'
              : !s.printing || s.print !== PAUSED
                ? 'not-paused'
                : s.error !== 0
                  ? 'print-error-reported'
                  : undefined,
          (s) => sameTask(s, taskId) && s.printing && ACTIVE.includes(s.print),
          undefined,
          guard,
        ),
      ),

    stop: (taskId: string, guard?: PhrozenWriteGuard) =>
      exclusive(() =>
        command(
          130,
          {},
          (s) =>
            !sameTask(s, taskId)
              ? 'task-mismatch'
              : !s.printing || !STOPPABLE.includes(s.print)
                ? 'not-printing'
                : undefined,
          (s) => sameTask(s, taskId) && s.print === STOPPED,
          undefined,
          guard,
        ),
      ),

    /** Starts a file already in /local/, always from layer 0. */
    start: (filename: string) =>
      exclusive<{ taskId: string }>(async () => {
        if (!safeFilename(filename)) return refused('invalid-filename')
        let files: string[]
        try {
          files = await listFiles()
        } catch {
          return refused('file-list-unavailable')
        }
        if (!files.includes(filename)) return refused('file-not-found')
        return command(
          128,
          { Filename: filename, StartLayer: 0 },
          (s) =>
            !s.idle || !SETTLED.includes(s.print)
              ? 'printer-not-idle'
              : undefined,
          (s, before) =>
            s.printing &&
            // Homing counts: the new task is running.
            (s.print === HOMING || ACTIVE.includes(s.print)) &&
            basename(s.filename) === filename &&
            s.taskId !== '' &&
            s.taskId !== before.taskId,
          START_ACKS,
        )
      }),

    /**
     * SDCP "Send File Interface": 1 MiB multipart packets sharing one Uuid.
     * Never overwrites, and confirms from the printer's own file list.
     */
    upload: (filename: string, bytes: Uint8Array, guard?: PhrozenWriteGuard) =>
      exclusive<{ filename: string; md5: string }>(async () => {
        if (!safeFilename(filename)) return refused('invalid-filename')
        if (!bytes.length || bytes.length > MAX_FILE_BYTES)
          return refused('invalid-file-size')
        const attributes = await gate('FILE_TRANSFER')
        if (isRefusal(attributes)) return attributes
        const types = attributes.SupportFileType
        const extension = filename.slice(filename.lastIndexOf('.') + 1)
        if (
          !filename.includes('.') ||
          !Array.isArray(types) ||
          !types.some(
            (type) =>
              typeof type === 'string' &&
              type.toLowerCase() === extension.toLowerCase(),
          )
        )
          return refused('file-type-not-reported')
        const before = await currentJob()
        if ('outcome' in before) return before
        if (!before.idle) return refused('printer-not-idle')
        try {
          if ((await listFiles()).includes(filename))
            return refused('file-exists')
        } catch {
          return refused('file-list-unavailable')
        }
        const md5 = createHash('md5').update(bytes).digest('hex')
        const uuid = randomUUID().replaceAll('-', '')
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          const form = new FormData()
          form.set('S-File-MD5', md5)
          form.set('Check', '1')
          form.set('Offset', String(offset))
          form.set('Uuid', uuid)
          form.set('TotalSize', String(bytes.length))
          form.set(
            'File',
            new Blob([
              new Uint8Array(bytes.subarray(offset, offset + CHUNK_BYTES)),
            ]),
            filename,
          )
          // Rechecked before every packet. After the first one the printer
          // holds a partial transfer, so a later denial is not "unsent".
          if (guard && !guard())
            return offset
              ? uncertain('upload-authority-lost')
              : refused('not-permitted')
          const failure = await postChunk(form)
          if (failure) return failure
        }
        const listed = await observe(async () =>
          (await listFiles()).includes(filename) ? true : undefined,
        )
        return listed
          ? { outcome: 'confirmed', filename, md5 }
          : uncertain('file-unconfirmed')
      }),

    /**
     * SDCP Cmd 386. Returns the RTSP address the printer reports, only when
     * it stays on the provisioned host.
     */
    async enableVideo(): Promise<PhrozenResult<{ url: string }>> {
      if (!STREAMING_FIRMWARE.has(firmware))
        return refused('firmware-without-streaming')
      const attributes = await gate('VIDEO_STREAM')
      if (isRefusal(attributes)) return attributes
      if (attributes.CameraStatus !== 1) return refused('camera-not-reported')
      const connected = attributes.NumberOfVideoStreamConnected
      const allowed = attributes.MaximumVideoStreamAllowed
      if (
        typeof connected !== 'number' ||
        typeof allowed !== 'number' ||
        !(connected < allowed)
      )
        return refused('stream-limit-reached')
      const reply = await send(386, { Enable: 1 }, VIDEO_ACKS)
      if ('outcome' in reply) return reply
      const url = reply.data.VideoUrl
      const target = typeof url === 'string' ? URL.parse(url) : null
      return typeof url === 'string' &&
        target?.protocol === 'rtsp:' &&
        target.hostname === endpoint.host &&
        !target.username &&
        !target.password
        ? { outcome: 'confirmed', url }
        : uncertain('video-url-rejected')
    },

    /** SDCP reports no stream switch, so success is only an acknowledgment. */
    async disableVideo(): Promise<
      { outcome: 'acknowledged' } | PhrozenRefusal | PhrozenUncertain
    > {
      const reply = await send(386, { Enable: 0 }, VIDEO_ACKS)
      return 'outcome' in reply ? reply : { outcome: 'acknowledged' }
    },

    /** SDCP Cmd 321. Undefined when the printer has no record of the task. */
    async readTaskUsage(taskId: string): Promise<PhrozenTaskUsage | undefined> {
      if (!taskId || taskId.length > 128) throw new Error('Invalid task id')
      const { ack, data } = await exchange(endpoint, 321, { Id: [taskId] })
      if (ack !== 0 || !Array.isArray(data.HistoryDetailList))
        throw new Error('Phrozen task details unavailable')
      const matches = data.HistoryDetailList.map((entry) =>
        object(entry),
      ).filter((entry) => entry.TaskId === taskId)
      if (matches.length > 1) throw new Error('Ambiguous Phrozen task details')
      const [task] = matches
      if (!task) return
      const volume = task.CurrentLayerTalVolume
      const layers = task.AlreadyPrintLayer
      return Object.freeze({
        board: endpoint.board,
        taskId,
        status:
          task.TaskStatus === 1
            ? 'completed'
            : task.TaskStatus === 2
              ? 'exception'
              : task.TaskStatus === 3
                ? 'stopped'
                : 'unsettled',
        beginTime: seconds(task.BeginTime),
        endTime: seconds(task.EndTime),
        printedLayers:
          Number.isSafeInteger(layers) && (layers as number) >= 0
            ? (layers as number)
            : null,
        volumeMl:
          typeof volume === 'number' && Number.isFinite(volume) && volume > 0
            ? volume
            : null,
      })
    },
  }
}
