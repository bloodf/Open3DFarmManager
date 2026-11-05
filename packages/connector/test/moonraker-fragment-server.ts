import { createServer } from 'node:http'
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'
const { WebSocketServer } = await import('ws')
const http = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(
    JSON.stringify({
      result: { klippy_connected: true, klippy_state: 'ready' },
    }),
  )
})
const sockets = new WebSocketServer({ server: http, perMessageDeflate: false })
sockets.on('connection', (socket) => {
  socket.on('error', () => {})
  socket.on('close', (code) => {
    process.stdout.write(JSON.stringify({ closeCode: code }) + '\n')
  })
  socket.once('message', () => {
    const result = {
      eventtime: 10,
      status: {
        webhooks: { state: 'ready' },
        print_stats: { state: 'printing' },
        virtual_sdcard: { progress: 0.5 },
      },
    }
    if (process.argv[2] === 'oversized')
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { ...result, metadata: 'x'.repeat(256 * 1024) },
        }),
      )
    else {
      const valid = JSON.stringify({ jsonrpc: '2.0', id: 1, result })
      for (let index = 0; index < 130; index++)
        socket.send(valid[index]!, { fin: false })
      socket.send(valid.slice(130), { fin: true })
    }
  })
})
http.listen(0, '127.0.0.1', () => {
  const address = http.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture address')
  process.stdout.write(
    JSON.stringify({ origin: `http://127.0.0.1:${address.port}` }) + '\n',
  )
})
function close() {
  for (const socket of sockets.clients) socket.terminate()
  sockets.close()
  http.closeAllConnections()
  http.close(() => {
    process.stdin.pause()
  })
}
process.stdin.once('data', close)
process.on('SIGTERM', close)
