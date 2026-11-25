import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'

const require = createRequire(
  new URL('../../connector/package.json', import.meta.url),
)
const { WebSocketServer } = require('ws') as typeof import('ws')

type Attributes = { MainboardID: string; MachineName: string }
type Fixture = {
  Id: string
  Data: Attributes | { Attributes: Attributes }
  fixtureStatus: Record<string, unknown>
}
type Fault = 'denied' | 'disconnect' | 'timeout' | 'malformed' | 'wrong-board'
/**
 * Per-command misbehaviour. `ignore` acknowledges without applying,
 * `lost-reply` applies and drops the socket, `drop` drops without applying,
 * a number is returned as the Ack without applying.
 */
type Behaviour = 'ignore' | 'lost-reply' | 'drop' | number
type UploadBehaviour = 'ignore' | 'lost-reply' | 'reject'

// Operations and reply shapes: CBD SDCP V3.0.0,
// https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
// State transitions are synthetic; no Phrozen capture backs them.
const OPERATIONS = new Set([1, 128, 129, 130, 131, 258, 321, 386])

export async function startPhrozenSimulator(fixture: Fixture, fault?: Fault) {
  const { Id, Data, fixtureStatus } = fixture
  const attrs = 'Attributes' in Data ? Data.Attributes : Data
  const board = attrs.MainboardID
  const udp = createSocket('udp4')
  const http = createServer()
  const server = new WebSocketServer({ server: http, path: '/websocket' })
  const commands: number[] = []
  const requests: { cmd: number; data: Record<string, unknown> }[] = []
  const behaviours = new Map<number, Behaviour>()

  // The printer's own state. Every reply below is read from it.
  const status: Record<string, unknown> = structuredClone(fixtureStatus)
  const printInfo = () => (status.PrintInfo ??= {}) as Record<string, unknown>
  /** Sub-states still to pass through, one per status request. */
  const pending: (() => void)[] = []
  const files = new Map<string, Buffer>()
  const history = new Map<string, Record<string, unknown>>()
  const attributes: Record<string, unknown> = {
    ...attrs,
    Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL', 'VIDEO_STREAM'],
    SupportFileType: ['CTB', 'PRZ'],
    CameraStatus: 1,
    NumberOfVideoStreamConnected: 0,
    MaximumVideoStreamAllowed: 1,
  }
  const video = { enabled: false, url: 'rtsp://127.0.0.1:554/video' }
  const uploads: { offset: number; uuid: string }[] = []
  const partial = new Map<string, Buffer>()
  let uploadBehaviour: UploadBehaviour | undefined
  let taskCount = 0
  const now = () => Math.floor(Date.now() / 1000)

  function move(via: number, to: number, machine: number) {
    printInfo().Status = via
    pending.push(() => {
      printInfo().Status = to
      status.CurrentStatus = [machine]
    })
  }

  /** Records the task under its id, as Cmd 321 reports it. */
  function settle(
    taskStatus: number,
    report: { volumeMl?: unknown; layers?: number; endTime?: number } = {},
  ) {
    const taskId = String(printInfo().TaskId)
    const task = history.get(taskId)
    if (!task) return
    Object.assign(task, {
      TaskStatus: taskStatus,
      EndTime: report.endTime ?? now(),
      AlreadyPrintLayer: report.layers ?? printInfo().CurrentLayer,
      ...('volumeMl' in report
        ? { CurrentLayerTalVolume: report.volumeMl }
        : {}),
    })
  }

  function begin(filename: string, beginTime = now()) {
    const taskId = `sim-task-${++taskCount}`
    status.CurrentStatus = [1]
    Object.assign(printInfo(), {
      Status: 1,
      CurrentLayer: 0,
      TotalLayer: 150,
      Filename: filename,
      ErrorNumber: 0,
      TaskId: taskId,
    })
    history.set(taskId, {
      TaskId: taskId,
      TaskName: filename,
      TaskStatus: 0,
      BeginTime: beginTime,
      EndTime: 0,
      AlreadyPrintLayer: 0,
    })
    return taskId
  }

  /** Applies a command to the state and returns the reply body. */
  function apply(
    cmd: number,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const machine = status.CurrentStatus as number[]
    const sub = Number(printInfo().Status)
    const printing = machine.includes(1)
    if (cmd === 128) {
      if (printing || data.StartLayer !== 0) return { Ack: 1 }
      if (!files.has(String(data.Filename))) return { Ack: 2 }
      begin(String(data.Filename))
      pending.push(() => (printInfo().Status = 3))
    } else if (cmd === 129) {
      if (!printing || ![2, 3, 4].includes(sub)) return { Ack: 1 }
      move(5, 6, 1)
    } else if (cmd === 131) {
      if (!printing || sub !== 6) return { Ack: 1 }
      move(4, 3, 1)
    } else if (cmd === 130) {
      if (!printing) return { Ack: 1 }
      move(7, 8, 0)
      pending.push(() => settle(3))
    } else if (cmd === 258) {
      return {
        Ack: 0,
        FileList: [...files].map(([name, bytes]) => ({
          name: `/local/${name}`,
          usedSize: bytes.length,
          storageType: 0,
          type: 1,
        })),
      }
    } else if (cmd === 321) {
      const ids = data.Id as string[]
      return {
        Ack: 0,
        HistoryDetailList: ids.flatMap((id) => {
          const task = history.get(id)
          return task ? [structuredClone(task)] : []
        }),
      }
    } else if (cmd === 386) {
      if (data.Enable === 1 && attributes.CameraStatus !== 1) return { Ack: 2 }
      video.enabled = data.Enable === 1
      return video.enabled ? { Ack: 0, VideoUrl: video.url } : { Ack: 0 }
    }
    return { Ack: 0 }
  }

  async function receive(request: IncomingMessage) {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const form = await new Request('http://simulator', {
      method: 'POST',
      headers: { 'content-type': String(request.headers['content-type']) },
      body: Buffer.concat(chunks),
    }).formData()
    const file = form.get('File') as File
    const bytes = Buffer.from(await file.arrayBuffer())
    const uuid = String(form.get('Uuid'))
    const offset = Number(form.get('Offset'))
    const total = Number(form.get('TotalSize'))
    uploads.push({ offset, uuid })
    const held = partial.get(uuid) ?? Buffer.alloc(0)
    if (uploadBehaviour === 'reject' || bytes.length > 1024 * 1024) return -4
    if (offset !== held.length) return -2
    const joined = Buffer.concat([held, bytes])
    partial.set(uuid, joined)
    if (joined.length === total) {
      partial.delete(uuid)
      const md5 = createHash('md5').update(joined).digest('hex')
      if (form.get('Check') === '1' && md5 !== form.get('S-File-MD5')) return -4
      if (uploadBehaviour !== 'ignore') files.set(file.name, joined)
    }
    return 0
  }

  http.on('request', (request, response) => {
    if (request.method !== 'POST' || request.url !== '/uploadFile/upload') {
      response.writeHead(404).end()
      return
    }
    receive(request).then(
      (code) => {
        if (uploadBehaviour === 'lost-reply') return request.socket.destroy()
        // SDCP "Send File Interface", response parameters.
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(
            code === 0
              ? {
                  code: '000000',
                  messages: null,
                  data: {},
                  success: true,
                }
              : {
                  code: '111111',
                  messages: [{ field: 'common_field', message: code }],
                  data: null,
                  success: false,
                },
          ),
        )
      },
      () => response.writeHead(400).end(),
    )
  })

  const close = async () => {
    for (const peer of server.clients) peer.terminate()
    server.close()
    http.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => udp.close(() => resolve())),
      new Promise<void>((resolve) => http.close(() => resolve())),
    ])
  }
  udp.on('message', (message, sender) => {
    if (message.toString() === 'M99999') {
      udp.send(JSON.stringify({ Id, Data }), sender.port, sender.address)
    }
  })
  server.on('connection', (peer) => {
    peer.on('message', (message) => {
      const packet = JSON.parse(message.toString())
      const { Cmd, Data, RequestID, MainboardID, From, TimeStamp } = packet.Data
      const fdm = attrs.MachineName === 'Centauri Carbon'
      commands.push(Cmd)
      requests.push({ cmd: Cmd, data: Data })
      const behaviour = behaviours.get(Cmd)
      if (behaviour === 'drop') return peer.close()
      if (fault === 'timeout') return
      if (fault === 'disconnect') return peer.close()
      if (fault === 'malformed') return peer.send('{')
      const denied =
        fault === 'denied' ||
        (Cmd !== 0 && Cmd !== 320 && (fdm || !OPERATIONS.has(Cmd))) ||
        packet.Id !== (fdm ? board : Id) ||
        packet.Topic !== `sdcp/request/${board}` ||
        MainboardID !== board ||
        !/^[a-f0-9]{16}$/.test(RequestID) ||
        From !== (fdm ? 1 : 0) ||
        !Number.isInteger(TimeStamp) ||
        Math.abs(Date.now() - TimeStamp * (fdm ? 1 : 1000)) > 5000
      let body: Record<string, unknown> = { Ack: 1 }
      if (!denied) {
        if (typeof behaviour === 'number') body = { Ack: behaviour }
        else if (Cmd === 320)
          body = {
            Ack: 0,
            HistoryData: history.size ? [...history.keys()] : ['fixture-task'],
          }
        else if (behaviour === 'ignore') body = { Ack: 0 }
        else body = apply(Cmd, Data)
      }
      if (behaviour === 'lost-reply') return peer.close()
      const frameBoard = fault === 'wrong-board' ? 'ffff' : board
      if (!denied && Cmd === 0) {
        peer.send(
          JSON.stringify({
            Topic: `sdcp/status/${board}`,
            MainboardID: frameBoard,
            Status: status,
          }),
        )
        // Each report advances the machine by one step.
        pending.shift()?.()
      }
      if (!denied && Cmd === 1 && body.Ack === 0) {
        peer.send(
          JSON.stringify({
            Topic: `sdcp/attributes/${board}`,
            MainboardID: frameBoard,
            Attributes: attributes,
          }),
        )
      }
      peer.send(
        JSON.stringify({
          Topic: `sdcp/response/${board}`,
          Data: { Cmd, RequestID, MainboardID: board, Data: body },
        }),
      )
    })
  })
  try {
    await Promise.all([
      once(udp, 'listening'),
      once(http, 'listening'),
      udp.bind(0, '127.0.0.1'),
      http.listen(0, '127.0.0.1'),
    ])
    return {
      udpPort: udp.address().port,
      wsPort: (http.address() as AddressInfo).port,
      commands,
      requests,
      close,
      /** What the printer would report now, without advancing it. */
      state: () => ({
        status: structuredClone(status),
        files: new Map(files),
        history: structuredClone([...history.values()]),
        videoEnabled: video.enabled,
        uploads: [...uploads],
      }),
      attributes,
      video,
      misbehave(cmd: number, behaviour: Behaviour | undefined) {
        if (behaviour === undefined) behaviours.delete(cmd)
        else behaviours.set(cmd, behaviour)
      },
      misbehaveUpload(behaviour: UploadBehaviour | undefined) {
        uploadBehaviour = behaviour
      },
      /** Puts the machine at rest with no job, as a booted printer. */
      reset() {
        pending.length = 0
        status.CurrentStatus = [0]
        Object.assign(printInfo(), {
          Status: 0,
          Filename: '',
          TaskId: '',
          ErrorNumber: 0,
        })
      },
      /** Overrides reported job fields, such as a printer error. */
      setPrintInfo(fields: Record<string, unknown>) {
        Object.assign(printInfo(), fields)
      },
      addFile(name: string, bytes = Buffer.from('synthetic')) {
        files.set(name, bytes)
      },
      /** A print started at the printer itself, already exposing. */
      beginPrint(filename: string, beginTime?: number) {
        const taskId = begin(filename, beginTime)
        printInfo().Status = 3
        return taskId
      },
      /** Ends the current print by itself and records its history entry. */
      endPrint(
        report: {
          volumeMl?: unknown
          layers?: number
          endTime?: number
          taskStatus?: number
        } = {},
      ) {
        pending.length = 0
        status.CurrentStatus = [0]
        printInfo().Status = 9
        settle(report.taskStatus ?? 1, report)
      },
      /** Sets history fields of a task, such as its late-arriving volume. */
      amendTask(taskId: string, fields: Record<string, unknown>) {
        Object.assign(history.get(taskId) ?? {}, fields)
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
