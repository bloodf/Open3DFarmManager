import { createServer, type TLSSocket } from 'node:tls'
import { readFileSync } from 'node:fs'

export async function fixture(stall = false) {
  const tls = {
    key: readFileSync(new URL('./key.pem', import.meta.url)),
    cert: readFileSync(new URL('./cert.pem', import.meta.url)),
  }
  const sockets = new Set<TLSSocket>()
  let uploaded = Buffer.alloc(0)
  let data: TLSSocket | undefined
  const track = (s: TLSSocket) => {
    sockets.add(s)
    s.on('error', () => {})
    s.on('close', () => sockets.delete(s))
  }
  const passive = createServer(tls, (s) => {
    track(s)
    data = s
    s.on('data', (b) => {
      uploaded = Buffer.concat([uploaded, b])
    })
  })
  await new Promise<void>((r) => passive.listen(0, '127.0.0.1', r))
  const address = passive.address()
  if (!address || typeof address === 'string')
    throw new Error('No passive port')
  const server = createServer(tls, (s) => {
    track(s)
    if (stall) return
    s.write('220 ready\r\n')
    let buffer = ''
    s.on('data', (b) => {
      buffer += b.toString()
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (line === 'USER bblp') s.write('331 password\r\n')
        else if (line.startsWith('PASS '))
          s.write(line === 'PASS secret' ? '230 ok\r\n' : '530 denied\r\n')
        else if (line === 'PASV')
          s.write(
            `227 passive (127,0,0,1,${address.port >> 8},${address.port & 255})\r\n`,
          )
        else if (line.startsWith('STOR ')) {
          s.write('150 send\r\n')
          if (!data) {
            passive.once('secureConnection', (stream) => {
              stream.once('end', () => {
                stream.end()
                s.write('226 done\r\n')
              })
            })
            continue
          }
          data!.once('end', () => {
            data!.end()
            s.write('226 done\r\n')
          })
        } else s.write('200 ok\r\n')
      }
    })
  })
  server.on('tlsClientError', () => {})
  passive.on('tlsClientError', () => {})
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('No port')
  return {
    port: addr.port,
    cert: tls.cert,
    bytes: () => uploaded,
    close: async () => {
      for (const s of sockets) s.destroy()
      await Promise.all(
        [server, passive].map(
          (s) => new Promise<void>((r) => s.close(() => r())),
        ),
      )
    },
  }
}
