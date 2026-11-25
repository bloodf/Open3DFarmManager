import dgram from 'node:dgram'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { WebSocketServer } from 'ws'

/**
 * Printer model behind the simulator. Frames and codes follow
 * cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215 (resin) and
 * ELEGOO-3D/elegoo-link @ ec2d226 with bjan/pycentauri @ 2f6d9ed (Carbon).
 * It is spec-derived, not a hardware capture.
 */
export type SdcpMachine = {
  family: 'resin' | 'fdm'
  phase: 'idle' | 'printing' | 'paused' | 'stopped' | 'complete'
  /** True while an upload is being stored (machine status 2). */
  transferring: boolean
  filename: string
  currentLayer: number
  totalLayer: number
  /** Stored files by name, filled by a completed and verified upload. */
  files: Map<string, Buffer>
  /** Resin only: finished tasks answered to Cmd 320 and 321. */
  history: SdcpSimulatedTask[]
  /** Resin only: address answered to Cmd 386; none means no camera. */
  videoUrl?: string
  /** Resin only: streams enabled and not yet disabled (limit 1). */
  videoStreams: number
  /** Fault switches. */
  fault?: {
    /** Acknowledge a command without applying it. */
    ignore?: boolean
    /** Refuse commands with this acknowledgement code. */
    ack?: number
    /** Reject the upload chunk at this offset. */
    rejectOffset?: number
  }
}

/** The `HistoryDetailList` fields of the spec that the simulator fills. */
export type SdcpSimulatedTask = {
  TaskId: string
  TaskName: string
  BeginTime: number
  EndTime: number
  /** 0 other, 1 completed, 2 exceptional, 3 stopped. */
  TaskStatus: number
}

const CMD_KEYS: Record<'resin' | 'fdm', string[]> = {
  resin: ['Filename', 'StartLayer'],
  fdm: [
    'Calibration_switch',
    'Filename',
    'PrintPlatformType',
    'StartLayer',
    'Tlp_Switch',
    'slot_map',
  ],
}

function statusFrame(machine: SdcpMachine, board: string) {
  const busy = machine.phase === 'printing' || machine.phase === 'paused'
  const phase = {
    idle: 0,
    printing: machine.family === 'fdm' ? 13 : 3,
    paused: 6,
    stopped: 8,
    complete: 9,
  }[machine.phase]
  return {
    MainboardID: board,
    Topic: `sdcp/status/${board}`,
    Status: {
      CurrentStatus: [machine.transferring ? 2 : busy ? 1 : 0],
      PrintInfo: {
        Status: phase,
        CurrentLayer: machine.currentLayer,
        TotalLayer: machine.totalLayer,
        Filename: machine.filename,
        // The Carbon's status omits ErrorNumber.
        ...(machine.family === 'resin' ? { ErrorNumber: 0 } : {}),
      },
    },
  }
}

/** History and video of a resin board (CBD spec, Cmd 320, 321 and 386). */
function query(
  machine: SdcpMachine,
  cmd: number,
  data: any,
): Record<string, unknown> {
  if (cmd === 320)
    return { Ack: 0, HistoryData: machine.history.map((task) => task.TaskId) }
  if (cmd === 321)
    return {
      Ack: 0,
      HistoryDetailList: machine.history.filter((task) =>
        data.Id.includes(task.TaskId),
      ),
    }
  if (data.Enable === 0) {
    machine.videoStreams = Math.max(0, machine.videoStreams - 1)
    return { Ack: 0 }
  }
  if (!machine.videoUrl) return { Ack: 2 }
  if (machine.videoStreams >= 1) return { Ack: 1 }
  machine.videoStreams += 1
  return { Ack: 0, VideoUrl: machine.videoUrl }
}

/** The payload shapes each family accepts; anything else is a crash. */
function shaped(family: SdcpMachine['family'], cmd: number, data: any) {
  const keys = Object.keys(data).sort().join()
  if (cmd === 128) return keys === CMD_KEYS[family].join()
  if ([0, 129, 130, 131].includes(cmd)) return keys === ''
  // Resin only: the Connector never sends these to the Carbon.
  if (family !== 'resin') return false
  if (cmd === 320) return keys === ''
  if (cmd === 321) return keys === 'Id' && Array.isArray(data.Id)
  return cmd === 386 && keys === 'Enable' && [0, 1].includes(data.Enable)
}

/** Applies one print command and returns its acknowledgement code. */
function apply(machine: SdcpMachine, cmd: number, data: any): number {
  if (machine.fault?.ack !== undefined) return machine.fault.ack
  if (machine.fault?.ignore) return 0
  const busy = machine.phase === 'printing' || machine.phase === 'paused'
  if (cmd === 128) {
    if (busy || machine.transferring) return 1
    if (!machine.files.has(data.Filename)) return 2
    machine.phase = 'printing'
    machine.filename = data.Filename
    machine.currentLayer = data.StartLayer
    machine.totalLayer = 100
    return 0
  }
  if (cmd === 129 && machine.phase === 'printing') machine.phase = 'paused'
  else if (cmd === 131 && machine.phase === 'paused') machine.phase = 'printing'
  else if (cmd === 130 && busy) {
    machine.phase = 'stopped'
    const now = Math.floor(Date.now() / 1000)
    machine.history.unshift({
      TaskId: `task-${machine.history.length + 1}`,
      TaskName: machine.filename,
      BeginTime: now - 60,
      EndTime: now,
      TaskStatus: 3,
    })
  } else return 1
  return 0
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('Too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Loopback-only SDCP v3 test double; never connects to a printer. */
export async function startSdcpSimulator(
  discovery: { Id: string; Data: Record<string, string> } = {
    Id: 'fixture',
    Data: {
      Name: 'Test',
      MachineName: 'Saturn 4 Ultra',
      MainboardIP: '127.0.0.1',
      MainboardID: 'fixture01',
      ProtocolVersion: 'V3.0.0',
      FirmwareVersion: 'V1.0.0',
    },
  },
  /** Fixed loopback address and ports for a journey; ephemeral by default. */
  listen: {
    discoveryPort?: number
    websocketPort?: number
  } = {},
) {
  const host = '127.0.0.1'
  const board = discovery.Data.MainboardID!
  const udp = dgram.createSocket('udp4')
  const http = createServer()
  const ws = new WebSocketServer({ server: http, path: '/websocket' })
  try {
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(listen.discoveryPort ?? 0, host, resolve)
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      // `ws` re-emits the server's listen error on the WebSocket server.
      ws.once('error', reject)
      http.listen(listen.websocketPort ?? 0, host, resolve)
    })
  } catch (error) {
    udp.close()
    ws.close()
    http.close()
    throw error
  }
  const requests: unknown[] = []
  const chunks: { offset: number; size: number; uuid: string }[] = []
  let response: unknown
  let machine: SdcpMachine | undefined
  let pending: { uuid: string; md5: string; parts: Buffer[] } | undefined
  const publish = (message: unknown) => {
    for (const client of ws.clients) client.send(JSON.stringify(message))
  }
  const report = () => {
    if (machine) publish(statusFrame(machine, board))
  }
  ws.on('connection', (client) =>
    client.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        requests.push(message)
        const { Cmd, Data, RequestID } = message.Data ?? {}
        if (!machine) {
          if (Cmd === 0 && response !== undefined)
            client.send(JSON.stringify(response))
          return
        }
        if (message.Topic !== `sdcp/request/${board}`) return
        // An unknown command or payload shape drops the connection, as the
        // Carbon's firmware does when its process dies.
        if (!shaped(machine.family, Cmd, Data)) return client.terminate()
        const answer = [320, 321, 386].includes(Cmd)
          ? query(machine, Cmd, Data)
          : { Ack: Cmd === 0 ? 0 : apply(machine, Cmd, Data) }
        client.send(
          JSON.stringify({
            Id: message.Id,
            Data: {
              Cmd,
              Data: answer,
              RequestID,
              MainboardID: board,
            },
            Topic: `sdcp/response/${board}`,
          }),
        )
        report()
      } catch {}
    }),
  )
  http.on('request', async (request, reply) => {
    const answer = (code: number | undefined) => {
      reply.setHeader('content-type', 'application/json')
      reply.end(
        JSON.stringify(
          code === undefined
            ? { code: '000000', messages: null, data: {}, success: true }
            : {
                code: '111111',
                messages: [{ field: 'common_field', message: code }],
                data: null,
                success: false,
              },
        ),
      )
    }
    try {
      if (
        !machine ||
        request.method !== 'POST' ||
        request.url !== '/uploadFile/upload'
      ) {
        reply.statusCode = 404
        return reply.end()
      }
      const form = await new Response(new Uint8Array(await readBody(request)), {
        headers: { 'content-type': request.headers['content-type']! },
      }).formData()
      const field = (name: string) => String(form.get(name))
      const file = form.get('File') as File
      const bytes = Buffer.from(await file.arrayBuffer())
      const offset = Number(field('Offset'))
      const total = Number(field('TotalSize'))
      const uuid = field('Uuid')
      chunks.push({ offset, size: bytes.length, uuid })
      if (machine.fault?.rejectOffset === offset) return answer(-4)
      if (bytes.length > 1024 * 1024 || field('Check') !== '1')
        return answer(-4)
      if (offset === 0) pending = { uuid, md5: field('S-File-MD5'), parts: [] }
      const received = pending
        ? pending.parts.reduce((sum, part) => sum + part.length, 0)
        : -1
      if (!pending || pending.uuid !== uuid || received !== offset)
        return answer(-2)
      pending.parts.push(bytes)
      machine.transferring = true
      if (received + bytes.length === total) {
        const stored = Buffer.concat(pending.parts)
        machine.transferring = false
        const md5 = createHash('md5').update(stored).digest('hex')
        const expected = pending.md5
        pending = undefined
        if (md5 !== expected) return answer(-4)
        machine.files.set(file.name, stored)
      }
      answer(undefined)
      report()
    } catch {
      answer(-4)
    }
  })
  udp.on('message', (message, peer) => {
    if (message.toString() === 'M99999')
      udp.send(JSON.stringify(discovery), peer.port, peer.address)
  })
  return {
    discoveryPort: udp.address().port,
    websocketPort: (http.address() as { port: number }).port,
    discovery,
    requests,
    chunks,
    setStatus(value: unknown) {
      response = value
    },
    /** Switches on the applying printer model. */
    simulate(initial: Partial<SdcpMachine> & { family: 'resin' | 'fdm' }) {
      machine = {
        phase: 'idle',
        transferring: false,
        filename: '',
        currentLayer: 0,
        totalLayer: 0,
        files: new Map(),
        history: [],
        videoStreams: 0,
        ...initial,
      }
      return machine
    },
    report,
    publish,
    connected: () => ws.clients.size,
    async close() {
      for (const client of ws.clients) client.terminate()
      http.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve) => udp.close(() => resolve())),
        new Promise<void>((resolve) => ws.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ])
    },
  }
}
