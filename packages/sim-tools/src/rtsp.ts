import { connect } from 'node:net'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function parseRtspUrl(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'rtsp:' || !LOOPBACK.has(url.hostname))
    throw new Error('RTSP URL must be rtsp:// on a loopback host')
  return {
    url,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 554),
  }
}

/**
 * Minimal RTSP-over-TCP client: DESCRIBE, SETUP (interleaved), PLAY, then counts
 * RTP packets. Resolves with the packet count once `minPackets` arrive.
 */
export async function verifyRtsp(
  rtspUrl: string,
  { minPackets = 10, timeoutMs = 15_000 } = {},
) {
  const { url, host, port } = parseRtspUrl(rtspUrl)
  const base = url.href
  return await new Promise<number>((resolve, reject) => {
    const socket = connect({ host, port })
    let buffer = Buffer.alloc(0)
    let step: 'describe' | 'setup' | 'play' | 'stream' = 'describe'
    let cseq = 0
    let session = ''
    let control = base
    let packets = 0
    const finish = (error?: Error, value?: number) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value ?? 0)
    }
    const timer = setTimeout(
      () =>
        finish(
          new Error(`RTSP stream gave ${packets} packets in ${timeoutMs} ms`),
        ),
      timeoutMs,
    )
    const send = (method: string, target: string, headers: string[] = []) => {
      cseq += 1
      const lines = [
        `${method} ${target} RTSP/1.0`,
        `CSeq: ${cseq}`,
        ...headers,
      ]
      if (session) lines.push(`Session: ${session}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    }
    socket.once('connect', () =>
      send('DESCRIBE', base, ['Accept: application/sdp']),
    )
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('RTSP connection closed early')))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 1_048_576)
        return finish(new Error('RTSP buffer exceeded'))
      while (buffer.length > 0) {
        if (buffer[0] === 0x24) {
          // interleaved frame: '$' channel len(2) payload
          if (buffer.length < 4) return
          const size = buffer.readUInt16BE(2)
          if (buffer.length < 4 + size) return
          if (
            (buffer[1] ?? 1) % 2 === 0 &&
            size >= 12 &&
            ++packets >= minPackets
          )
            return finish(undefined, packets)
          buffer = buffer.subarray(4 + size)
          continue
        }
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.subarray(0, end).toString('latin1')
        const len = Number(/^Content-Length:\s*(\d+)/im.exec(head)?.[1] ?? 0)
        if (buffer.length < end + 4 + len) return
        const body = buffer.subarray(end + 4, end + 4 + len).toString('latin1')
        buffer = buffer.subarray(end + 4 + len)
        if (!/^RTSP\/1\.0 200/.test(head))
          return finish(
            new Error(`RTSP ${step} failed: ${head.split('\r\n')[0]}`),
          )
        if (step === 'describe') {
          if (!/^m=video /m.test(body))
            return finish(new Error('SDP has no video track'))
          const track = /^a=control:(.+)$/m
            .exec(body.slice(body.indexOf('m=video')))?.[1]
            ?.trim()
          if (track && track !== '*')
            control = /^rtsp:/.test(track)
              ? track
              : `${base.replace(/\/$/, '')}/${track}`
          step = 'setup'
          send('SETUP', control, [
            'Transport: RTP/AVP/TCP;unicast;interleaved=0-1',
          ])
        } else if (step === 'setup') {
          session = /^Session:\s*([^;\r\n]+)/im.exec(head)?.[1] ?? ''
          step = 'play'
          send('PLAY', base, ['Range: npt=0.000-'])
        } else if (step === 'play') step = 'stream'
      }
    })
  })
}
