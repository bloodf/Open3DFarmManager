import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
} from 'node:http'
import type { AddressInfo } from 'node:net'

export async function startPrusaSimulator(reply: RequestListener) {
  const server = createServer(reply)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}

// Stateful PrusaLink printer. Operations are applied to the simulated printer
// and become visible only through what it reports afterwards. All values are
// synthetic; routes, gates and status codes follow these sources.
//
// buddy: prusa3d/Prusa-Firmware-Buddy @ b1043d68be188ad27ea72a14e160140e30e589f0
//   lib/WUI/link_content/prusa_link_api_v1.cpp      routes, job id and gates
//   lib/WUI/link_content/prusa_api_helpers.cpp      /usb only, start 204/404/409
//   lib/WUI/link_content/basic_gets.cpp             version, info, job
//   lib/WUI/nhttp/status_renderer.cpp               status, job only while active
//   lib/WUI/nhttp/gcode_upload.cpp, server.cpp      upload 201/409/501
//   utils/gen-automata/http.py                      Overwrite, Print-After-Upload
//   src/state/printer_state.cpp                     reported states: pausing and
//     resuming report PAUSED, aborting reports PRINTING; BUSY has no job,
//     ATTENTION keeps it and reports PAUSED on /api/v1/job; READY is never
//     reported because the status route asks get_state(false)
//   src/common/marlin_client.cpp                    a start that stops at a
//     print preview question still counts as started (204)
//   src/common/marlin_server.cpp                    aborting that question ends
//     in IDLE
//   lib/WUI/nhttp/gcode_upload.cpp                  one transfer at a time (409)
//
// pi: prusa3d/Prusa-Link @ 58a0ab1703680c32d39c76684e906c8f2ea91464
//   prusa/link/web/{main,files,cameras}.py, web/lib/{auth,files}.py,
//   prusa/link/conditions.py

export type PrusaLinkSimulatorHost = 'buddy' | 'pi-prusalink'
export type PrusaLinkSimulatorState =
  'IDLE' | 'PRINTING' | 'PAUSED' | 'FINISHED' | 'STOPPED' | 'ERROR'

export type PrusaLinkSimulatorOptions = Readonly<{
  host?: PrusaLinkSimulatorHost
  /** Buddy only: the `printer` string. Pi PrusaLink reports none. */
  printerType?: string
  serial: string
  apiKey: string
  /** An example label, not a qualified firmware. */
  firmware?: string
  /** Enables the synthetic Connect Local read view of this printer. */
  connect?: Readonly<{ token: string; deviceId: string; camera: string }>
}>

/** Buddy states that override the print state until the printer leaves them. */
export type PrusaLinkSimulatorCondition = 'BUSY' | 'ATTENTION'

type Job = { id: number; file: string; progress: number }

export async function startPrusaLinkPrinterSimulator(
  options: PrusaLinkSimulatorOptions,
) {
  const host = options.host ?? 'buddy'
  const isBuddy = host === 'buddy'
  if (isBuddy && !options.printerType)
    throw new Error('A Buddy simulator needs a printer type')
  const storage = isBuddy ? 'usb' : 'local'
  const files = new Map<string, Buffer>()
  const history: { device_id: string; id: string; state: string }[] = []
  const requests: {
    method: string
    path: string
    authorized: boolean
    status: number
  }[] = []
  let state: PrusaLinkSimulatorState = 'IDLE'
  let job: Job | undefined
  let jobId = 0
  let online = true
  let dropReply = false
  // The transition an accepted command still has to complete.
  let pending: (() => void) | undefined
  let condition: PrusaLinkSimulatorCondition | undefined
  // ATTENTION raised by a print preview question: the print never began.
  let preview = false
  let askNextStart = false
  let transferring = false
  let uploadedPreview: string | undefined
  // 'absent': no camera. 'empty': no photo taken yet.
  let camera: 'absent' | 'empty' | Buffer = 'absent'

  function begin(file: string) {
    uploadedPreview = undefined
    job = { id: ++jobId, file, progress: 0 }
    state = 'PRINTING'
    pending = undefined
    preview = askNextStart
    condition = askNextStart ? 'ATTENTION' : undefined
    askNextStart = false
  }

  function leaveCondition() {
    condition = undefined
    preview = false
  }

  function end(next: 'FINISHED' | 'STOPPED' | 'ERROR') {
    if (job)
      history.push({
        device_id: options.connect?.deviceId ?? options.serial,
        id: String(job.id),
        state: next,
      })
    state = next
    pending = undefined
    leaveCondition()
  }

  const active = () => state === 'PRINTING' || state === 'PAUSED'
  const ready = () =>
    !condition &&
    (state === 'IDLE' || state === 'FINISHED' || state === 'STOPPED')
  const reported = () => condition ?? state
  // BUSY reports no job at all.
  const hasJob = () => active() && condition !== 'BUSY'

  type Reply = { status: number; body?: unknown; image?: Buffer }
  const json = (body: unknown): Reply => ({ status: 200, body })
  const code = (status: number): Reply => ({ status })

  function snap(): Reply {
    if (camera === 'absent') return code(404)
    if (camera === 'empty') return code(204)
    return { status: 200, image: camera }
  }

  function version() {
    const common = {
      api: '2.0.0',
      text: 'PrusaLink',
      hostname: 'prusa-sim',
      capabilities: { 'upload-by-put': true },
    }
    return isBuddy
      ? {
          ...common,
          server: '2.1.2',
          nozzle_diameter: 0.4,
          firmware: options.firmware ?? '8.0.2',
          printer: options.printerType,
        }
      : {
          ...common,
          server: '0.8.1',
          original: 'PrusaLink I3MK3S',
          firmware: options.firmware ?? '3.14.1',
        }
  }

  function status() {
    const printing = state === 'PRINTING'
    return {
      ...(job && hasJob()
        ? { job: { id: job.id, progress: job.progress, time_printing: 60 } }
        : {}),
      ...(transferring
        ? {
            transfer: {
              id: 1,
              time_transferring: 3,
              progress: 40,
              transferred: 4,
            },
          }
        : {}),
      printer: {
        state: reported(),
        temp_nozzle: active() ? 214.9 : 24.1,
        target_nozzle: active() ? 215 : 0,
        temp_bed: active() ? 59.5 : 23.8,
        target_bed: active() ? 60 : 0,
        fan_hotend: active() ? 4200 : 0,
        fan_print: printing ? 5100 : 0,
      },
    }
  }

  function currentJob(): Reply {
    if (!job || !hasJob()) return code(204)
    return json({
      id: job.id,
      state: condition === 'ATTENTION' ? 'PAUSED' : state,
      progress: job.progress,
      file: { name: job.file, display_name: job.file },
    })
  }

  function jobCommand(method: string, id: number, command?: string): Reply {
    if (id !== jobId || !jobId) return code(404)
    if (method === 'DELETE' && command === undefined) {
      if (condition === 'BUSY' || (!condition && !active())) return code(409)
      pending = preview
        ? () => {
            state = 'IDLE'
            job = undefined
            leaveCondition()
          }
        : () => end('STOPPED')
      return code(204)
    }
    if (method !== 'PUT') return code(405)
    if (command === 'pause') {
      if (reported() !== 'PRINTING') return code(409)
      if (isBuddy) {
        // Pausing already reports PAUSED.
        state = 'PAUSED'
        pending = undefined
      } else pending = () => (state = 'PAUSED')
      return code(204)
    }
    if (command === 'resume') {
      if (reported() !== 'PAUSED') return code(409)
      pending = () => (state = 'PRINTING')
      return code(204)
    }
    return code(400)
  }

  function fileRequest(
    method: string,
    target: string,
    name: string,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): Reply {
    if (target !== storage) {
      if (isBuddy) return code(403)
      if (target !== 'sdcard') return code(404)
      if (method === 'PUT') return code(409)
    }
    const key = `${target}/${name}`
    if (method === 'GET') {
      const file = files.get(key)
      return file
        ? json({
            name,
            display_name: name,
            type: 'PRINT_FILE',
            size: file.byteLength,
          })
        : code(404)
    }
    if (method === 'PUT') {
      if (!body.byteLength) return code(isBuddy ? 501 : 411)
      if (transferring) return code(409)
      if (files.has(key) && headers.overwrite !== '?1') return code(409)
      files.set(key, body)
      const flag = String(headers['print-after-upload'] ?? '')
      if ((isBuddy ? ['true', '1', '?1'] : ['?1']).includes(flag)) {
        if (!ready()) return code(409)
        begin(name)
      } else if (isBuddy && ready() && !uploadedPreview) {
        // Buddy wui_api.cpp, wui_start_print: best-effort preview is
        // permitted only when another image preview is not already open.
        uploadedPreview = name
      }
      return code(201)
    }
    if (method === 'POST') {
      if (!files.has(key)) return code(404)
      if (!ready()) return code(409)
      begin(name)
      return code(204)
    }
    return code(405)
  }

  function route(
    method: string,
    path: string,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): Reply {
    if (method === 'GET') {
      if (path === '/api/version') return json(version())
      if (path === '/api/v1/info')
        return json({
          serial: options.serial,
          nozzle_diameter: 0.4,
          hostname: 'prusa-sim',
          min_extrusion_temp: 170,
        })
      if (path === '/api/v1/status') return json(status())
      if (path === '/api/v1/job') return currentJob()
      if (path === '/api/v1/cameras/snap') return isBuddy ? code(404) : snap()
    }
    const command = /^\/api\/v1\/job\/(\d+)(?:\/([a-z]+))?$/.exec(path)
    if (command) return jobCommand(method, Number(command[1]), command[2])
    const file = /^\/api\/v1\/files\/([^/]+)\/([^/]+)$/.exec(path)
    if (file)
      return fileRequest(
        method,
        decodeURIComponent(file[1]!),
        decodeURIComponent(file[2]!),
        headers,
        body,
      )
    return code(404)
  }

  // Connect Local view. The reply shapes are synthetic: the adapter only relies
  // on the item list, the echoed device id and the history page.
  // https://github.com/prusa3d/prusa-connect/tree/main/docs/src/content/docs/reference/api
  function connectRoute(method: string, url: URL): Reply {
    const connect = options.connect!
    if (method !== 'GET') return code(405)
    const device = {
      id: connect.deviceId,
      connected: true,
      issues: [],
      state: { '/state': reported() },
    }
    const prefix = `/api/v1/devices/${connect.deviceId}`
    if (url.pathname === '/api/v1/devices') return json({ items: [device] })
    if (url.pathname === prefix) return json(device)
    if (url.pathname === `${prefix}/jobs/history`)
      return json({ items: history })
    if (url.pathname === `/api/v1/cameras/${connect.camera}/snapshot`)
      return snap()
    return code(404)
  }

  const server = await startPrusaSimulator(async (req, res) => {
    const method = req.method ?? ''
    const url = new URL(req.url ?? '/', 'http://prusa-sim')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const bearer = req.headers.authorization
    const viaConnect = options.connect !== undefined && bearer !== undefined
    const authorized = viaConnect
      ? bearer === `Bearer ${options.connect!.token}`
      : req.headers['x-api-key'] === options.apiKey
    const reply = !authorized
      ? code(viaConnect || !isBuddy ? 403 : 401)
      : !online
        ? code(503)
        : viaConnect
          ? connectRoute(method, url)
          : route(method, url.pathname, req.headers, Buffer.concat(chunks))
    requests.push({
      method,
      path: url.pathname,
      authorized,
      status: reply.status,
    })
    if (dropReply && method !== 'GET') {
      // The command was applied; only its acknowledgement is lost.
      dropReply = false
      req.socket.destroy()
      return
    }
    if (reply.image)
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(reply.image)
    else if (reply.body === undefined) res.writeHead(reply.status).end()
    else
      res
        .writeHead(reply.status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(reply.body))
  })

  return {
    ...server,
    requests,
    /** Completes the transition the last accepted command left in flight. */
    settle() {
      const transition = pending
      pending = undefined
      transition?.()
    },
    setProgress(percent: number) {
      if (!job || !active()) throw new Error('No simulated job')
      job.progress = percent
    },
    finishPrint() {
      if (!job || !active()) throw new Error('No simulated job')
      job.progress = 100
      end('FINISHED')
    },
    failPrint() {
      if (!job || !active()) throw new Error('No simulated job')
      end('ERROR')
    },
    /** A print started at the printer itself. */
    startLocalPrint(file: string) {
      begin(file)
    },
    /** Buddy only: raises or clears a dialog or an internal busy phase. */
    setCondition(next: PrusaLinkSimulatorCondition | undefined) {
      if (!isBuddy) throw new Error('Only the Buddy simulator has conditions')
      if (next) {
        condition = next
        preview = false
      } else leaveCondition()
    },
    /** Buddy only: the next start stops at a print preview question. */
    askBeforeNextStart() {
      if (!isBuddy) throw new Error('Only the Buddy simulator asks')
      askNextStart = true
    },
    /** Another transfer holds the printer's single transfer slot. */
    setTransfer(next: boolean) {
      transferring = next
    },
    setCamera(next: 'absent' | 'empty' | Buffer) {
      camera = next
    },
    setOnline(next: boolean) {
      online = next
    },
    loseNextCommandReply() {
      dropReply = true
    },
    storedFile: (path: string) => files.get(path),
    uploadedPreview: () => uploadedPreview,
  }
}
