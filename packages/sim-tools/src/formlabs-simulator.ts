import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

// PreForm API v1.0.0-alpha.1 routes used by the Connector. Synthetic behavior
// from https://developer.formlabs.com/reference/openapi-v1.yml, not a capture.
export type FormlabsSimPrinter = {
  id: string
  productName: string
  machineTypeIds: string[]
  connectionType: string
  connected: boolean
  /** Whether an upload without print_now would start on an idle printer. */
  autoStart: boolean
  /** Time remaining that a started job reports. */
  durationMs: number
  /** Set false to accept a start without ever reporting it. */
  reportsStart: boolean
}
type SimJob = { jobId: string; jobName: string; machineType: string }
/**
 * `drop-*` closes the socket before or after the request takes effect.
 * `reply` answers with the given status and error code without any effect.
 */
export type FormlabsSimFault =
  | { kind: 'drop-before' }
  | { kind: 'drop-after' }
  | { kind: 'reply'; status: number; code: string }

class SimError extends Error {
  readonly status: number
  readonly code: string
  constructor(code: string, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

async function readBody(req: IncomingMessage) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > 131072) throw new SimError('PAYLOAD_TOO_LARGE', 413)
  }
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new SimError('JSON_PARSE_ERROR')
  }
}
function exact(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some((key) => !keys.includes(key)))
    throw new SimError('JSON_SCHEMA_MATCH_ERROR')
}

/** Loopback-only PreForm host test double. */
export async function startFormlabsSimulator() {
  const requests: string[] = []
  const deviceResponseStatuses: number[] = []
  let response: unknown = { count: 0, devices: [] }
  let status = 200
  const printers = new Map<
    string,
    FormlabsSimPrinter & { queue: SimJob[]; printing: SimJob | null }
  >()
  /** .form files on the simulated server's filesystem: one entry per scene. */
  const files = new Map<string, string[]>()
  const scenes = new Map<string, string>()
  const faults = new Map<string, FormlabsSimFault>()
  const printBodies: unknown[] = []
  let onSceneOpen: (() => void) | undefined

  const ready = (printer: { autoStart: boolean; printing: SimJob | null }) =>
    printer.autoStart && !printer.printing
  function deviceList() {
    const devices = [...printers.values()]
      .filter((printer) => printer.connected)
      .map((printer) => ({
        id: printer.id,
        product_name: printer.productName,
        status: 'Synthetic human-readable status',
        is_connected: true,
        connection_type: printer.connectionType,
        ip_address: '192.0.2.1',
        firmware_version: 'synthetic',
        is_remote_print_enabled: false,
        estimated_print_time_remaining_ms:
          printer.printing && printer.reportsStart ? printer.durationMs : 0,
        tank_id: 'sim-tank',
        tank_material_code: 'FLGPBK05',
        cartridge_data: {
          'sim-cartridge': {
            cartridgeMaterialCode: 'FLGPBK05',
            cartridgeEstimatedVolumeDispensed_mL: 125.5,
            cartridgeOriginalVolume_mL: 1000,
          },
        },
        ...(/^form 3/i.test(printer.productName)
          ? { form_auto_status: 'Synthetic Form Auto status' }
          : {}),
        ready_to_print_now: ready(printer),
      }))
    return { count: devices.length, devices }
  }

  async function v1(req: IncomingMessage): Promise<unknown> {
    const route = `${req.method} ${req.url}`
    if (route === 'GET /v1/device/list/') return deviceList()
    if (route === 'POST /v1/print-setting/list/') {
      const body = await readBody(req)
      exact(body, ['compatible_with'])
      const printer = printers.get(String(body.compatible_with))
      if (!printer?.connected) throw new SimError('NOT_FOUND', 404)
      return {
        printer_types: [
          {
            label: printer.productName,
            supported_machine_type_ids: printer.machineTypeIds,
            supported_product_names: [printer.productName],
          },
        ],
      }
    }
    if (route === 'POST /v1/scene/open/') {
      const body = await readBody(req)
      exact(body, ['file'])
      const file = String(body.file)
      if (!/\.form$/i.test(file)) throw new SimError('INPUT_ERROR')
      const machineTypes = files.get(file)
      if (!machineTypes) throw new SimError('OPERATION_FAILED')
      const opened = machineTypes.map((machineType, index) => {
        const id = randomUUID()
        scenes.set(id, machineType)
        return {
          scene_id: id,
          scene_settings: {
            machine_type: machineType,
            material_code: 'FLGPBK05',
            print_setting: 'DEFAULT',
            layer_thickness_mm: '0.1',
          },
          new_model_ids: [],
          scene_name: `scene-${index}`,
        }
      })
      onSceneOpen?.()
      return { project_name: 'synthetic', scenes: opened }
    }
    if (route === 'DELETE /v1/scene/delete/') {
      const body = await readBody(req)
      if (!scenes.delete(String(body.scene_id)))
        throw new SimError('INPUT_ERROR')
      return undefined
    }
    if (route === 'POST /v1/scene/print/') {
      const body = await readBody(req)
      printBodies.push(body)
      exact(body, [
        'scene_id',
        'printer',
        'job_name',
        'find_printer_timeout_seconds',
        'print_now',
      ])
      if (
        typeof body.scene_id !== 'string' ||
        typeof body.printer !== 'string' ||
        typeof body.job_name !== 'string' ||
        (body.print_now !== undefined && typeof body.print_now !== 'boolean')
      )
        throw new SimError('JSON_SCHEMA_MATCH_ERROR')
      const machineType = scenes.get(body.scene_id)
      if (!machineType) throw new SimError('INPUT_ERROR')
      const printer = printers.get(body.printer)
      if (!printer?.connected) throw new SimError('OPERATION_FAILED')
      const startNow = body.print_now ?? ready(printer)
      if (startNow && !ready(printer)) throw new SimError('OPERATION_FAILED')
      const job = {
        jobId: randomUUID(),
        jobName: body.job_name,
        machineType,
      }
      if (startNow) printer.printing = job
      else printer.queue.push(job)
      return { job_id: job.jobId }
    }
    throw new SimError('NOT_FOUND', 404)
  }

  async function handleV1(req: IncomingMessage, res: ServerResponse) {
    const route = `${req.method} ${req.url}`
    const fault = faults.get(route)
    faults.delete(route)
    if (fault?.kind === 'drop-before') return void req.socket.destroy()
    try {
      if (fault?.kind === 'reply') throw new SimError(fault.code, fault.status)
      const result = await v1(req)
      if (fault?.kind === 'drop-after') return void req.socket.destroy()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(result === undefined ? undefined : JSON.stringify(result))
    } catch (error) {
      const known =
        error instanceof SimError ? error : new SimError('UNKNOWN_FAILURE', 500)
      res.writeHead(known.status, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: { code: known.code, message: 'Synthetic error' },
        }),
      )
    }
  }

  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.url?.startsWith('/v1/')) return void handleV1(req, res)
    if (req.method !== 'GET' || req.url !== '/devices/') {
      res.writeHead(404).end()
      return
    }
    deviceResponseStatuses.push(status)
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify(response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    requests,
    deviceResponseStatuses,
    setResponse(value: unknown, code = 200) {
      response = value
      status = code
    },
    printBodies,
    addPrinter(
      printer: Pick<
        FormlabsSimPrinter,
        'id' | 'productName' | 'machineTypeIds'
      > &
        Partial<FormlabsSimPrinter>,
    ) {
      printers.set(printer.id, {
        connectionType: 'ETHERNET',
        connected: true,
        autoStart: true,
        durationMs: 3_600_000,
        reportsStart: true,
        ...printer,
        queue: [],
        printing: null,
      })
    },
    /**
     * State held by the simulated printer. The maker's API exposes no queue or
     * job, so tests read it here and not through an HTTP route.
     */
    printerState(id: string) {
      const printer = printers.get(id)
      if (!printer) throw Error('Unknown simulated printer')
      return structuredClone({
        queue: printer.queue,
        printing: printer.printing,
      })
    },
    updatePrinter(id: string, patch: Partial<FormlabsSimPrinter>) {
      const printer = printers.get(id)
      if (!printer) throw Error('Unknown simulated printer')
      Object.assign(printer, patch)
    },
    addFormFile(path: string, sceneMachineTypes: string[]) {
      files.set(path, sceneMachineTypes)
    },
    openSceneCount: () => scenes.size,
    /** Applies to the next request of this method and path. */
    failNext(route: string, fault: FormlabsSimFault) {
      faults.set(route, fault)
    },
    afterSceneOpen(hook: () => void) {
      onSceneOpen = hook
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
