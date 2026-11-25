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
  discoveryPid = 36,
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

// Original stateful fixtures for https://github.com/Parallel-7/flashforge-api-docs/wiki/HTTP-REST-API
export function startStatefulFlashforgeSimulator(fixture: {
  pid: number
  detail: Record<string, unknown>
  files: readonly string[]
}) {
  const detail = { ...fixture.detail }
  const files = new Set(fixture.files)

  return startFlashforgeSimulator(async (req, res, body) => {
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
    if (fixture.pid !== 35 && fixture.pid !== 36) return reject()
    if (
      req.url === '/printGcode' &&
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
        case 'temperatureCtl_cmd':
          if (typeof args.rightNozzle === 'number')
            detail.rightTargetTemp =
              args.rightNozzle === -100 ? 0 : args.rightNozzle
          else if (typeof args.platform === 'number')
            detail.platTargetTemp = args.platform === -100 ? 0 : args.platform
          else return reject()
          break
        case 'printerCtl_cmd':
          if (
            detail.status !== 'printing' ||
            typeof args.coolingFan !== 'number'
          )
            return reject()
          detail.coolingFanSpeed = args.coolingFan
          break
        default:
          return reject()
      }
    } else return reject()
    send({ code: 0 })
  }, fixture.pid)
}
