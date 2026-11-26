import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'

export async function startFlashforgeSimulator(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
  ) => void | Promise<void>,
  // Printer-PIDs: 0x0023 is Adventurer 5M; 0x0024 is 5M Pro.
  // https://github.com/Parallel-7/flashforge-api-docs/wiki/Printer-PIDs
  discoveryPid: number = 0x0024,
) {
  const host = '127.0.0.1'
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      await handler(req, res, Buffer.concat(chunks))
    } catch (error) {
      res.destroy(error instanceof Error ? error : undefined)
    }
  })
  const udp = createSocket('udp4')
  udp.on('message', (_data, sender) => {
    const packet = Buffer.alloc(280)
    packet.writeUInt16BE(0x2b71, 0x86)
    packet.writeUInt16BE(discoveryPid, 0x88)
    packet.writeUInt16BE(8898, 0x8e)
    packet.write('FIXTURE-SERIAL', 0x92)
    udp.send(packet, sender.port, sender.address)
  })
  await Promise.all([
    once(server.listen(0, host), 'listening'),
    once(udp.bind(0, host), 'listening'),
  ])
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing simulator address')
  return {
    host,
    port: address.port,
    discoveryPort: udp.address().port,
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => udp.close(resolve)),
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        }),
      ])
    },
  }
}

// Original stateful fixture. Wire reference: Parallel-7/flashforge-api-docs
// wiki at 885702f, HTTP-REST-API.md and AD5X-IFS-Material-Station.md.
function temperatureTarget(value: unknown, maximum: number) {
  if (value === -100) return 0
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximum
  )
    return value
}
export async function startStatefulFlashforgeSimulator(fixture: {
  pid: number
  detail: Record<string, unknown>
  files: readonly string[]
}) {
  const detail = { ...fixture.detail }
  const files = new Set(fixture.files)
  let loadingSlot: number | undefined
  /** Paths of every request and every authenticated write, in arrival order. */
  const requests: string[] = []
  const writes: { path: string; payload?: unknown }[] = []
  /** `/control` acknowledges commands it ignores (wiki HTTP-REST-API). */
  const faults = { ignoreControl: false }

  const simulator = await startFlashforgeSimulator(async (req, res, body) => {
    requests.push(`${req.method} ${req.url}`)
    const send = (payload: object) => res.end(JSON.stringify(payload))
    const reject = () => {
      send({ code: 1 })
    }
    if (
      req.method === 'GET' &&
      req.url === '/?action=stream' &&
      detail.cameraStreamUrl
    ) {
      res.writeHead(200, {
        'content-type': 'multipart/x-mixed-replace; boundary=fixture',
      })
      res.end(
        '--fixture\r\nContent-Type: image/jpeg\r\n\r\nfixture-frame\r\n--fixture--\r\n',
      )
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    if (req.url === '/uploadGcode') {
      if (fixture.pid !== 35 && fixture.pid !== 36) return reject()
      if (
        req.headers.serialnumber !== 'FIXTURE-SERIAL' ||
        req.headers.checkcode !== 'fixture01' ||
        req.headers.printnow !== 'false' ||
        detail.status !== 'ready'
      )
        return reject()
      const form = await new Response(new Uint8Array(body), {
        headers: { 'content-type': req.headers['content-type'] ?? '' },
      }).formData()
      const file = form.get('gcodeFile')
      if (
        !(file instanceof File) ||
        !file.size ||
        String(file.size) !== req.headers.filesize
      )
        return reject()
      files.add(file.name)
      send({ code: 0 })
      return
    }
    const data = JSON.parse(body.toString())
    if (
      data.serialNumber !== 'FIXTURE-SERIAL' ||
      data.checkCode !== 'fixture01'
    )
      return reject()
    if (req.url === '/detail') {
      send({ code: 0, detail })
      // The load shows as running once, then completes and returns to idle
      // (wiki AD5X-IFS-Material-Station, "State Codes").
      if (loadingSlot !== undefined) {
        detail.matlStationInfo = {
          ...(detail.matlStationInfo as object),
          stateAction: 0,
          stateStep: 0,
          currentSlot: loadingSlot,
          currentLoadSlot: 0,
        }
        loadingSlot = undefined
      }
      return
    }
    if (req.url === '/gcodeList') {
      send(
        fixture.pid === 38
          ? {
              code: 0,
              gcodeListDetail: Array.from(files, (gcodeFileName) => ({
                gcodeFileName,
              })),
            }
          : { code: 0, gcodeList: [...files] },
      )
      return
    }
    writes.push({ path: req.url ?? '', payload: data.payload })
    if (req.url === '/control' && faults.ignoreControl) {
      send({ code: 0 })
      return
    }
    if (![35, 36, 38].includes(fixture.pid)) return reject()
    if (
      req.url === '/printGcode' &&
      // The AD5X multi-material start is not simulated: the adapter refuses it.
      fixture.pid !== 38 &&
      detail.status === 'ready' &&
      files.has(data.fileName) &&
      data.levelingBeforePrint === true
    ) {
      detail.status = 'printing'
      detail.printProgress = 0
      detail.printFileName = data.fileName
    } else if (req.url === '/control') {
      const { cmd, args } = data.payload
      switch (cmd) {
        case 'jobCtl_cmd':
          switch (args.action) {
            case 'pause':
              if (detail.status !== 'printing') return reject()
              detail.status = 'pause'
              break
            case 'continue':
              if (detail.status !== 'pause') return reject()
              detail.status = 'printing'
              break
            case 'cancel':
              if (
                !['printing', 'pause', 'heating'].includes(
                  String(detail.status),
                )
              )
                return reject()
              detail.status = 'cancel'
              detail.printFileName = ''
              break
            default:
              return reject()
          }
          break
        case 'temperatureCtl_cmd': {
          const nozzle = temperatureTarget(args.rightNozzle, 265)
          const bed = temperatureTarget(args.platform, 100)
          if (nozzle === undefined && bed === undefined) return reject()
          if (nozzle !== undefined) detail.rightTargetTemp = nozzle
          if (bed !== undefined) detail.platTargetTemp = bed
          break
        }
        case 'printerCtl_cmd':
          if (
            detail.status !== 'printing' ||
            typeof args.coolingFan !== 'number' ||
            !Number.isInteger(args.coolingFan) ||
            args.coolingFan < 0 ||
            args.coolingFan > 100
          )
            return reject()
          detail.coolingFanSpeed = args.coolingFan
          break
        case 'streamCtrl_cmd':
          // The AD5X does not document this command.
          if (
            fixture.pid === 38 ||
            (args.action !== 'open' && args.action !== 'close')
          )
            return reject()
          detail.cameraStreamUrl =
            args.action === 'open' ? 'http://127.0.0.1:8080/?action=stream' : ''
          break
        case 'msConfig_cmd': {
          const station = detail.matlStationInfo as
            | { stateAction?: number; slotInfos: { slotId: number }[] }
            | undefined
          if (
            fixture.pid !== 38 ||
            detail.status !== 'ready' ||
            station?.stateAction !== 0 ||
            !station.slotInfos.some((slot) => slot.slotId === args.slot) ||
            typeof args.mt !== 'string' ||
            typeof args.rgb !== 'string' ||
            !/^[0-9A-F]{6}$/.test(args.rgb)
          )
            return reject()
          detail.matlStationInfo = {
            ...station,
            slotInfos: station.slotInfos.map((slot) =>
              slot.slotId === args.slot
                ? {
                    ...slot,
                    materialName: args.mt,
                    materialColor: `#${args.rgb}`,
                  }
                : slot,
            ),
          }
          break
        }
        case 'ms_cmd': {
          const station = detail.matlStationInfo as
            | {
                stateAction?: number
                slotInfos: { slotId: number; hasFilament: boolean }[]
              }
            | undefined
          if (
            fixture.pid !== 38 ||
            detail.status !== 'ready' ||
            args.action !== 0 ||
            station?.stateAction !== 0 ||
            !station.slotInfos.some(
              (slot) => slot.slotId === args.slot && slot.hasFilament,
            )
          )
            return reject()
          loadingSlot = args.slot
          detail.matlStationInfo = {
            ...station,
            stateAction: 1,
            stateStep: 2,
            currentLoadSlot: args.slot,
          }
          break
        }
        default:
          return reject()
      }
    } else return reject()
    send({ code: 0 })
  }, fixture.pid)
  return Object.assign(simulator, { detail, requests, writes, faults })
}
