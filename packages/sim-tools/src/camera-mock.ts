// SPDX-License-Identifier: MIT
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createCameraServer } from '../../sim-cams/src/server.ts'

/** Loopback-only cameras. Each instance owns all of its sockets and timers. */
export async function startCameraMock(options: { rtspPort?: number; token?: string } = {}) {
  const annex = await readFile(new URL('../../sim-cams/fixtures/test-pattern.h264', import.meta.url))
  const starts: { start: number; data: number }[] = []
  for (let i = 0; i < annex.length - 3; i++) {
    if (annex[i] === 0 && annex[i + 1] === 0 && (annex[i + 2] === 1 || (annex[i + 2] === 0 && annex[i + 3] === 1))) {
      const size = annex[i + 2] === 1 ? 3 : 4
      starts.push({ start: i, data: i + size }); i += size - 1
    }
  }
  const nals = starts.map((s, i) => annex.subarray(s.data, starts[i + 1]?.start ?? annex.length))
  const sps = nals.find(n => (n[0]! & 31) === 7)!
  const pps = nals.find(n => (n[0]! & 31) === 8)!
  const token = options.token ?? 'camera-token'
  const state = { stall: false, disconnect: false }
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const rtsp = createTcpServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    let buffer = ''; let sequence = 0; let timestamp = 0
    let timer: ReturnType<typeof setInterval> | undefined
    socket.once('close', () => { if (timer) { clearInterval(timer); timers.delete(timer) } })
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1')
      while (buffer.includes('\r\n\r\n')) {
        const end = buffer.indexOf('\r\n\r\n'); const request = buffer.slice(0, end); buffer = buffer.slice(end + 4)
        const method = request.split(' ')[0]; const cseq = /CSeq:\s*(\d+)/i.exec(request)?.[1] ?? '1'
        let body = ''; let headers = ''
        if (method === 'DESCRIBE') {
          body = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Mock camera\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=${sps.subarray(1, 4).toString('hex')};sprop-parameter-sets=${sps.toString('base64')},${pps.toString('base64')}\r\na=control:trackID=0\r\n`
          headers = `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
        } else if (method === 'SETUP') headers = 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nSession: mock\r\n'
        else if (method === 'PLAY') headers = 'Session: mock\r\n'
        else { socket.write(`RTSP/1.0 405 Method Not Allowed\r\nCSeq: ${cseq}\r\n\r\n`); continue }
        socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n${headers}\r\n${body}`)
        if (method === 'PLAY' && !timer) {
          const send = () => {
            if (state.disconnect) { socket.destroy(); return }
            if (state.stall) return
            for (const nal of nals) {
              const fragments: Buffer[] = []
              if (nal.length <= 1200) fragments.push(nal)
              else for (let offset = 1; offset < nal.length; offset += 1198) {
                const last = offset + 1198 >= nal.length
                fragments.push(Buffer.concat([Buffer.from([(nal[0]! & 0xe0) | 28, (nal[0]! & 31) | (offset === 1 ? 0x80 : 0) | (last ? 0x40 : 0)]), nal.subarray(offset, offset + 1198)]))
              }
              for (const [index, payload] of fragments.entries()) {
                const rtp = Buffer.alloc(12); rtp[0] = 0x80; rtp[1] = 96 | (index === fragments.length - 1 ? 0x80 : 0); rtp.writeUInt16BE(sequence++ & 0xffff, 2); rtp.writeUInt32BE(timestamp >>> 0, 4); rtp.writeUInt32BE(1, 8)
                const head = Buffer.alloc(4); head[0] = 36; head.writeUInt16BE(rtp.length + payload.length, 2)
                socket.write(Buffer.concat([head, rtp, payload]))
              }
              timestamp += 18000
            }
          }
          timer = setInterval(send, 1000); timers.add(timer); send()
        }
      }
    })
  })
  const camera = await createCameraServer()
  const flv = createHttpServer((req, res) => {
    if (req.url !== `/live/${token}`) { res.writeHead(403).end(); return }
    res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-store' })
    const tag = (payload: Buffer, time: number) => { const h = Buffer.alloc(11); h[0] = 9; h.writeUIntBE(payload.length, 1, 3); h.writeUIntBE(time & 0xffffff, 4, 3); h[7] = (time >>> 24) & 255; const prev = Buffer.alloc(4); prev.writeUInt32BE(11 + payload.length); return Buffer.concat([h, payload, prev]) }
    const config = Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0, 1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1, sps.length >> 8, sps.length & 255]), sps, Buffer.from([1, pps.length >> 8, pps.length & 255]), pps])
    res.write(Buffer.concat([Buffer.from('464c5601010000000900000000', 'hex'), tag(config, 0)]))
    let time = 0
    const send = () => { if (state.disconnect) { res.destroy(); return } if (state.stall) return; for (const nal of nals.filter(n => [1, 5].includes(n[0]! & 31))) { const len = Buffer.alloc(4); len.writeUInt32BE(nal.length); res.write(tag(Buffer.concat([Buffer.from([(nal[0]! & 31) === 5 ? 0x17 : 0x27, 1, 0, 0, 0]), len, nal]), time)); time += 200 } }
    const timer = setInterval(send, 1000); timers.add(timer); res.once('close', () => { clearInterval(timer); timers.delete(timer) }); send()
  })
  try {
    camera.server.listen(0, '127.0.0.1'); await once(camera.server, 'listening')
    rtsp.listen(options.rtspPort ?? 0, '127.0.0.1'); await once(rtsp, 'listening')
    flv.listen(0, '127.0.0.1'); await once(flv, 'listening')
  } catch (error) { await camera.close(); rtsp.close(); flv.close(); throw error }
  const port = (server: typeof rtsp) => { const address = server.address(); if (!address || typeof address === 'string') throw Error('Camera unavailable'); return address.port }
  return { cameraUrl: `http://127.0.0.1:${port(camera.server)}`, rtspUrl: `rtsp://127.0.0.1:${port(rtsp)}/test`, flvUrl: `http://127.0.0.1:${port(flv)}/live/${token}`, state, async close() { for (const timer of timers) clearInterval(timer); for (const socket of sockets) socket.destroy(); flv.closeAllConnections(); await Promise.all([camera.close(), new Promise<void>(resolve => rtsp.close(() => resolve())), new Promise<void>(resolve => flv.close(() => resolve()))]) } }
}
