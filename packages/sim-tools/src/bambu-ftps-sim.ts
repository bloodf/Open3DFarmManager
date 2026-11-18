// SPDX-License-Identifier: MIT
import { createServer } from 'node:tls'
import type { TLSSocket } from 'node:tls'

type TlsServer = ReturnType<typeof createServer>

export interface BambuFtpsSimOptions {
  host: string
  port: number
  accessCode: string
  key: Buffer | string
  cert: Buffer | string
  uploads: Map<string, Buffer>
}

/** Implicit-TLS FTPS endpoint emulating the Bambu SD-card file service. */
export async function startBambuFtpsSim(options: BambuFtpsSimOptions) {
  const { host, accessCode, key, cert, uploads } = options
  const sockets = new Set<TLSSocket>()
  const passiveServers = new Set<TlsServer>()

  function track(socket: TLSSocket) {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  }

  const ftps = createServer({ cert, key }, (control) => {
    track(control)
    control.write('220 Bambu simulator ready\r\n')
    let buffer = ''
    let dataServer: TlsServer | undefined
    let dataSocket: TLSSocket | undefined

    const withDataSocket = (use: (socket: TLSSocket) => void) => {
      if (dataSocket) return use(dataSocket)
      dataServer?.once('secureConnection', (socket: TLSSocket) => {
        dataSocket = socket
        track(socket)
        use(socket)
      })
    }

    const openPassive = () => {
      dataServer?.close()
      dataSocket = undefined
      const server = createServer({ cert, key }, (socket) => {
        track(socket)
        dataSocket = socket
      })
      dataServer = server
      passiveServers.add(server)
      server.once('close', () => passiveServers.delete(server))
      server.listen(0, host, () => {
        const address = server.address()
        if (!address || typeof address === 'string') return control.destroy()
        const octets = host.split('.').map(Number)
        control.write(
          `227 Entering Passive Mode (${[...octets, address.port >> 8, address.port & 255].join(',')})\r\n`,
        )
      })
    }

    const handle = (line: string) => {
      if (line === 'USER bblp') control.write('331 password required\r\n')
      else if (line.startsWith('PASS '))
        control.write(
          line === `PASS ${accessCode}`
            ? '230 logged in\r\n'
            : '530 invalid credentials\r\n',
        )
      else if (line === 'PASV') openPassive()
      else if (line === 'MLSD') {
        control.write('150 Opening protected data connection\r\n')
        withDataSocket((socket) => {
          const listing = [...uploads]
            .map(
              ([name, data]) =>
                `type=file;size=${data.length};modify=20261118000000; ${name}\r\n`,
            )
            .join('')
          socket.end(listing, () => {
            control.write('226 Listing complete\r\n')
            dataServer?.close()
          })
        })
      } else if (line.startsWith('STOR ')) {
        const name = line.slice(5)
        if (!/^[A-Za-z0-9_. -]{1,255}$/.test(name)) {
          control.write('550 Invalid name\r\n')
          return
        }
        control.write('150 Opening protected data connection\r\n')
        withDataSocket((socket) => {
          const chunks: Buffer[] = []
          socket.on('data', (data: Buffer) => chunks.push(data))
          socket.on('end', () => {
            uploads.set(name, Buffer.concat(chunks))
            control.write('226 Transfer complete\r\n')
            dataServer?.close()
          })
        })
      } else if (line === 'QUIT') {
        control.write('221 goodbye\r\n')
        control.end()
      } else control.write('200 ok\r\n')
    }

    control.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > 65536) return control.destroy()
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        handle(line)
      }
    })
  })
  ftps.on('tlsClientError', () => {})

  await new Promise<void>((resolve, reject) => {
    ftps.once('error', reject)
    ftps.listen(options.port, host, () => {
      ftps.removeListener('error', reject)
      resolve()
    })
  })
  const address = ftps.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing FTPS listener')

  let closing: Promise<void> | undefined
  return {
    port: address.port,
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy()
        await Promise.all(
          [ftps, ...passiveServers].map(
            (listener) =>
              new Promise<void>((resolve) => listener.close(() => resolve())),
          ),
        )
      })()
      return closing
    },
  }
}
