import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { verifyRtsp } from '../../packages/sim-tools/src/rtsp.ts'

const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n'

function fakeRtsp(describeStatus = '200 OK', split = false, packets = 5) {
  const server = createServer((socket) => {
    socket.on('data', (data) => {
      const text = data.toString()
      const cseq = /CSeq: (\d+)/.exec(text)?.[1]
      const reply = (extra = '', body = '', status = '200 OK') =>
        socket.write(
          `RTSP/1.0 ${status}\r\nCSeq: ${cseq}\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`,
        )
      if (text.startsWith('DESCRIBE')) reply('', sdp, describeStatus)
      else if (text.startsWith('SETUP')) reply('Session: abc;timeout=60\r\n')
      else if (text.startsWith('PLAY')) {
        reply()
        const rtp = Buffer.concat([
          Buffer.from([0x24, 0, 0, 12]),
          Buffer.alloc(12),
        ])
        const bytes = Buffer.concat(Array.from({ length: packets }, () => rtp))
        if (split) {
          socket.write(bytes.subarray(0, 2))
          setTimeout(() => socket.write(bytes.subarray(2, 9)), 20)
          setTimeout(() => socket.write(bytes.subarray(9)), 40)
        } else socket.write(bytes)
      }
    })
  })
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `rtsp://127.0.0.1:${(server.address() as AddressInfo).port}/test`,
        close: () => server.close(),
      }),
    ),
  )
}

describe('verifyRtsp', () => {
  it('reassembles $ frames split across TCP chunks', async () => {
    const rtsp = await fakeRtsp('200 OK', true)
    await expect(verifyRtsp(rtsp.url, { minPackets: 5 })).resolves.toBe(5)
    rtsp.close()
  })
  it('times out when too few packets arrive', async () => {
    const rtsp = await fakeRtsp('200 OK', false, 2)
    await expect(
      verifyRtsp(rtsp.url, { minPackets: 5, timeoutMs: 300 }),
    ).rejects.toThrow('2 packets')
    rtsp.close()
  })
  it('rejects URLs with credentials', async () => {
    await expect(verifyRtsp('rtsp://u:p@127.0.0.1/test')).rejects.toThrow(
      'credentials',
    )
  })
  it('counts RTP packets over interleaved TCP', async () => {
    const rtsp = await fakeRtsp()
    await expect(verifyRtsp(rtsp.url, { minPackets: 5 })).resolves.toBe(5)
    rtsp.close()
  })
  it('rejects a failed DESCRIBE', async () => {
    const rtsp = await fakeRtsp('404 Not Found')
    await expect(verifyRtsp(rtsp.url)).rejects.toThrow('describe failed')
    rtsp.close()
  })
  it('rejects non-loopback hosts', async () => {
    await expect(verifyRtsp('rtsp://example.com/test')).rejects.toThrow(
      'loopback',
    )
  })
})
