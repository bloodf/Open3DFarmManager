import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import {
  startAnycubicPrint,
  uploadAnycubicFile,
  listAnycubicFiles,
} from '../../packages/connector/src/anycubic/files.ts'

test('undocumented upload body and listing schema fail closed', async () => {
  await assert.rejects(uploadAnycubicFile(), /Unsupported Anycubic upload/)
  await assert.rejects(listAnycubicFiles(), /Unsupported Anycubic listing/)
})

test('documented start envelope crosses a loopback transport', async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const accepted = once(server, 'connection')
  const socket = connect(address.port, '127.0.0.1')
  const [peer] = await accepted
  try {
    const received = once(peer, 'data')
    const input = {
      model: '20024',
      deviceId: 'device',
      filename: 'test/model.gcode',
      signal: new AbortController().signal,
      transport: {
        async publish(topic: string, payload: string) {
          socket.write(JSON.stringify({ topic, payload: JSON.parse(payload) }))
        },
      },
    }
    await startAnycubicPrint(input)
    const [bytes] = await received
    const wire = JSON.parse(bytes.toString())
    assert.equal(
      wire.topic,
      'anycubic/anycubicCloud/v1/slicer/printer/20024/device/print',
    )
    assert.equal(wire.payload.action, 'start')
    assert.deepEqual(wire.payload.data, {
      taskid: '-1',
      filename: 'test/model.gcode',
      filetype: 1,
    })
    for (const filename of [
      '../x.gcode',
      '/x.gcode',
      'x%2fg.gcode',
      'x\n.gcode',
    ])
      await assert.rejects(
        startAnycubicPrint({ ...input, filename }),
        /Invalid/,
      )
    await assert.rejects(
      startAnycubicPrint({ ...input, model: 'unknown' }),
      /Unsupported/,
    )
    await assert.rejects(
      startAnycubicPrint({ ...input, signal: AbortSignal.abort() }),
    )
  } finally {
    socket.destroy()
    peer.destroy()
    server.close()
    await once(server, 'close')
  }
})
