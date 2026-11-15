import { createServer } from 'node:tls'
import type { TLSSocket } from 'node:tls'

// Public disposable synthetic identity. Never use for a real printer.
const cert = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUIz5W9pVEWkuHCHkhRPa1b/Gp/BAwDQYJKoZIhvcNAQEL
BQAwHzEdMBsGA1UEAwwUU1lOVEhFVElDLUJBTUJVLU9OTFkwHhcNMjYxMTE0MDgx
NzI0WhcNMzYxMTExMDgxNzI0WjAfMR0wGwYDVQQDDBRTWU5USEVUSUMtQkFNQlUt
T05MWTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANQ/B37QifJRnGYI
xK5nNxIWux356aE+SJ4IruzP7oCHAnulW7B89ziQZsk1jCs/wkNw/yDlJUS9T2hb
ieU7HMLSdm+A3ItVaM7umEIIdi5TvWPXjFC+tRqMuk2HiMCRzeNOzybF58rTqMcg
FGTaP9bTXhsiISyX+mhkrbuyUovjFV8mgjGCou8nRQuiPyScug0bTs8D5JnGit/9
bYc6v1jH9kkWpxfGc2thHEgMx0aSty9AuQ7BdAM50YHrY2Cea9Fj0xfLTNGNxNBV
69lYRD8bEwhJEHHA+wv/6qBdl/9+cI9Pc+w4R3TejHJx1/ufietvhWOU3mwNX8z/
a3vi35ECAwEAAaNDMEEwHQYDVR0OBBYEFEpxYUzS0fNExWC23ZsLevVAhBipMA8G
A1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEfwAAATANBgkqhkiG9w0BAQsFAAOC
AQEAQNQVLPbrRtyh32AjJEctDcbALJRqt0Vm0Bmwdbc4xM8qPxp8fnEs75XPZfex
e/gfD2WpYsWBbKm5Ii9yhcwd3Q0RPqH7k3w5qRSQfqR2qjPgVoHGJ2w2CPFfdT6y
43Q2gO7TSqlijLiyVADC7s4Uo7YvjFzyUirP1zLXT3dEpx0A+qOLjAquFEmwa6zQ
iuqR6YDi9FxrT2nMoDB/zqBJn0phcCjeFpsh2uOLnZih1MhiXH+IHgvRthu4NfVO
97uWo29eqlhic+SMgJ+dmWeWW4JDhaRsbr4eLDkt8sq9smRf9M+Q15bMeWp5iTSI
2Qch7i7xHkiDog0JmvgNxH6oTg==
-----END CERTIFICATE-----
`
const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDUPwd+0InyUZxm
CMSuZzcSFrsd+emhPkieCK7sz+6AhwJ7pVuwfPc4kGbJNYwrP8JDcP8g5SVEvU9o
W4nlOxzC0nZvgNyLVWjO7phCCHYuU71j14xQvrUajLpNh4jAkc3jTs8mxefK06jH
IBRk2j/W014bIiEsl/poZK27slKL4xVfJoIxgqLvJ0ULoj8knLoNG07PA+SZxorf
/W2HOr9Yx/ZJFqcXxnNrYRxIDMdGkrcvQLkOwXQDOdGB62NgnmvRY9MXy0zRjcTQ
VevZWEQ/GxMISRBxwPsL/+qgXZf/fnCPT3PsOEd03oxycdf7n4nrb4VjlN5sDV/M
/2t74t+RAgMBAAECggEAAbvdlG9A7zw0MD+yVp/keub5Ypht7ImpF3Rn9GqK7t0b
e7XZOsb8kIdadZqUwW4xCLLBvMuuayI2RbqYtOkPljZYrhbCBnfdRjJ8By8RQxXf
SlNik67JJTVA2N0KdJNEWK7mQZF0kCs8Ods023GOe7NolYVo+rennaZz5mCBrN+b
VWtC6c2N4/MqS/OtHgV5K3hR1wRCg1W4UP55N1AytDfRSlH0X83XTcU+j+0txsFV
Hr/kUZA5D/nHTxDrcq7tDH45L1ZpDIi/AbKVXiocnOVpbkw4lNTzKR7p6EpbK+ez
NFwFjdB5MyQO6JfKEPDNKN5Txy3pqAs1WaVs7tx2wQKBgQD7jXm0jum5jLE8zw17
FmKM5TlvBuijuT/7A/8bwsML4xKHSrt9FuZZTZDBYxftP52bZDLUevAOo0+AdpTQ
5UmrYHC2og8jC929AIPgYbgkn7YYdv/0fMgTcmpQi1BZfpyrWOsbtF/j3qcBrtEs
7Nhb310FkuS3jrGyLsRPPmfcMQKBgQDX/6dD1PCuzo9/EMgi0WWJ41RtR0/HMooy
CSlQYAiEsvbCbZe9J+wvGkOshRZ3MnqEiGdWdoKeAKgDiRtkWVJekyDPkKVx0rI4
+HtJF6SIk7os+VWZc34ystUBctOF/AMhSpsi675ScATztbnQyG5P2y+JrJ1Xt/I7
lZyPKaBBYQKBgBJHM2K1R7Jd0LsUaGxbMgn+1e+FVv4ehdGddrnzquyAMWZ3PaxX
L6Gpiy0iICjzCGa0HyVlUXAe2bYB58pN/s5fEZGTsPng8Nm84dg6AYFXwYmBjBOd
xYP0Ollj5hC6rHOe4GaA8r7B/OyYYUacZxQ15LJ0+/2CdtL1pvoDFNThAoGAXyJR
yHWEYGnIF/4LOBKkNzwyFkN/ZsvixDD2yljRx6iPOIlOeNiZlRFrVxPzFiLchX0S
jql51B+T4KLFtsgEmHUS0Xjy9ZQIPUFsA4BvTlxKdr6GriSJI8lSOeYaNfwOYN5c
P+A3HlYKSFD0+3kb5P40DN5DGryA6y91GjUKSWECgYEAgui9u5WIC2KULU/ZOSw7
S6up1338Pu2151983Vpj032FB3kdSM7lSSirUNbO8WBC2FEXY28zq+0ZvssHX2In
2cp9o2RfdQe0dAysbdKUGRv8P61TT6kFzSh96Z14JqNjU5ZWLCVddOdH0jIem3fL
2xq2f+nS9vnMvhfNWtiBonA=
-----END PRIVATE KEY-----
`
const MAX = 65536
export function packet(header: number, body: Buffer) {
  const length: number[] = []
  let n = body.length
  do {
    let digit = n % 128
    n = Math.floor(n / 128)
    if (n) digit |= 128
    length.push(digit)
  } while (n)
  return Buffer.concat([Buffer.from([header, ...length]), body])
}
export async function startBambuSimulator({
  serial = 'SYNTHETIC',
  port = 0,
  initialState,
  confirmCommands = true,
}: {
  serial?: string
  port?: number
  initialState?: 'RUNNING' | 'PAUSE' | 'IDLE'
  confirmCommands?: boolean
} = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serial))
    throw new Error('Invalid synthetic serial')
  const reportTopic = `device/${serial}/report`
  let gcodeState = initialState
  const extended: Record<string, unknown> = {}
  const requests: { command: string; sequence_id: string }[] = []
  function report(socket: TLSSocket) {
    const topic = Buffer.from(reportTopic)
    const length = Buffer.alloc(2)
    length.writeUInt16BE(topic.length)
    socket.write(
      packet(
        48,
        Buffer.concat([
          length,
          topic,
          Buffer.from(
            JSON.stringify({
              print: { gcode_state: gcodeState, mc_percent: 25, ...extended },
            }),
          ),
        ]),
      ),
    )
  }
  const sockets = new Set<TLSSocket>()
  const subscribed = new Set<TLSSocket>()
  const server = createServer(
    { cert, key, handshakeTimeout: 3000 },
    (socket) => {
      let buffer = Buffer.alloc(0)
      let connected = false
      const reports = setInterval(() => {
        if (gcodeState && subscribed.has(socket)) report(socket)
      }, 100)
      socket.once('close', () => clearInterval(reports))
      socket.setTimeout(10000, () => socket.destroy())
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > MAX) {
          socket.destroy()
          return
        }
        try {
          while (buffer.length >= 2) {
            let size = 0,
              factor = 1,
              offset = 1
            while (true) {
              if (offset >= buffer.length) return
              const digit = buffer[offset++]!
              size += (digit & 127) * factor
              if (size > MAX || offset > 5) throw new Error('Packet limit')
              if (!(digit & 128)) break
              factor *= 128
            }
            if (buffer.length < offset + size) return
            const header = buffer[0]!
            const body = buffer.subarray(offset, offset + size)
            buffer = buffer.subarray(offset + size)
            if (!connected) {
              if (
                header !== 16 ||
                body.length < 12 ||
                body.subarray(0, 7).toString('hex') !== '00044d51545404' ||
                (body[7] !== 2 && body[7] !== 194)
              )
                throw new Error('CONNECT required')
              let cursor = 10
              const fields = body[7] === 194 ? 3 : 1
              for (let field = 0; field < fields; field++) {
                if (cursor + 2 > body.length)
                  throw new Error('Missing CONNECT field')
                const length = body.readUInt16BE(cursor)
                cursor += 2
                if (!length || cursor + length > body.length)
                  throw new Error('Invalid CONNECT field')
                cursor += length
              }
              if (cursor !== body.length)
                throw new Error('Trailing CONNECT bytes')
              connected = true
              socket.write(Buffer.from([32, 2, 0, 0]))
            } else if (header === 130) {
              if (body.length < 5 || body.readUInt16BE(0) === 0)
                throw new Error('Invalid subscription')
              const length = body.readUInt16BE(2)
              if (body.length !== length + 5 || body.at(-1) !== 0)
                throw new Error('Only QoS 0 supported')
              const accepted =
                body.subarray(4, 4 + length).toString() === reportTopic
              if (accepted) subscribed.add(socket)
              socket.write(
                Buffer.from([144, 3, body[0]!, body[1]!, accepted ? 0 : 128]),
              )
              if (accepted && gcodeState) report(socket)
            } else if (header === 48) {
              if (body.length < 2) throw new Error('Invalid request')
              const length = body.readUInt16BE(0)
              if (
                body.subarray(2, 2 + length).toString() !==
                `device/${serial}/request`
              )
                throw new Error('Invalid request topic')
              const value = JSON.parse(body.subarray(2 + length).toString())
              const request = value?.print ?? value?.system
              const command = request?.command
              if (
                ![
                  'pause',
                  'resume',
                  'stop',
                  'gcode_line',
                  'ledctrl',
                  'print_speed',
                  'project_file',
                  'ams_change_filament',
                ].includes(command) ||
                typeof request?.sequence_id !== 'string'
              )
                throw new Error('Invalid request')
              requests.push({ command, sequence_id: request.sequence_id })
              if (confirmCommands) {
                if (command === 'gcode_line') {
                  const match = /^(M104|M140|M106 P[123]) S(\d+)\n$/.exec(
                    request.param,
                  )
                  const home = /^G28 ([XYZ](?: [XYZ])*)\n$/.exec(request.param)
                  if (match) extended[match[1]!] = Number(match[2])
                  else if (home) extended.homed_axes = home[1]
                  else throw new Error('Invalid gcode')
                } else if (
                  command === 'ledctrl' &&
                  request.led_node === 'chamber_light' &&
                  ['on', 'off'].includes(request.led_mode)
                )
                  extended.light = request.led_mode
                else if (
                  command === 'print_speed' &&
                  /^[1-4]$/.test(request.param)
                )
                  extended.speed = request.param
                else if (
                  command === 'project_file' &&
                  request.param === 'Metadata/plate_1.gcode' &&
                  typeof request.url === 'string' &&
                  request.url.startsWith('file:///sdcard/')
                ) {
                  extended.file = request.url
                  gcodeState = 'RUNNING'
                } else if (
                  command === 'ams_change_filament' &&
                  Number.isInteger(request.target) &&
                  ((request.target >= 0 && request.target <= 15) ||
                    request.target === 255) &&
                  Number.isInteger(request.curr_temp) &&
                  request.curr_temp >= 0 &&
                  request.curr_temp <= 300 &&
                  Number.isInteger(request.tar_temp) &&
                  request.tar_temp >= 0 &&
                  request.tar_temp <= 300
                )
                  extended.ams = { tray_now: String(request.target) }
                else if (!['pause', 'resume', 'stop'].includes(command))
                  throw new Error('Invalid request')
                if (['pause', 'resume', 'stop'].includes(command))
                  gcodeState =
                    command === 'pause'
                      ? 'PAUSE'
                      : command === 'resume'
                        ? 'RUNNING'
                        : 'IDLE'
                for (const subscriber of subscribed) report(subscriber)
              }
            } else if (header === 192 && !size)
              socket.write(Buffer.from([208, 0]))
            else if (header === 224 && !size) socket.destroy()
            else throw new Error('Unsupported packet; commands forbidden')
          }
        } catch {
          socket.destroy()
        }
      })
    },
  )
  server.on('connection', (socket) => {
    sockets.add(socket as TLSSocket)
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket as TLSSocket)
      subscribed.delete(socket as TLSSocket)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing listener')
  async function disconnectClients() {
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', resolve)
            socket.destroy()
          }),
      ),
    )
  }
  let closing: Promise<void> | undefined
  return {
    host: '127.0.0.1',
    port: address.port,
    syntheticTrust: cert,
    reportTopic,
    requests,
    get extendedState() {
      return { ...extended }
    },
    get gcodeState() {
      return gcodeState
    },
    publishReport(value: unknown) {
      const payload = Buffer.from(
        typeof value === 'string' ? value : JSON.stringify(value),
      )
      if (payload.length > MAX - 256) throw new Error('Report too large')
      const topic = Buffer.from(reportTopic)
      const length = Buffer.alloc(2)
      length.writeUInt16BE(topic.length)
      const bytes = packet(48, Buffer.concat([length, topic, payload]))
      for (const socket of subscribed) {
        if (socket.writableLength > MAX) socket.destroy()
        else socket.write(bytes)
      }
    },
    disconnectClients,
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        await disconnectClients()
        await closed
      })()
      return closing
    },
  }
}
