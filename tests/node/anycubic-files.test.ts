import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { provisionAnycubicPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import {
  startAnycubicPrint,
  uploadAnycubicFile,
  listAnycubicFiles,
} from '../../packages/connector/src/anycubic/files.ts'

test('bound Anycubic listing and multipart upload use the documented LAN wire', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'anycubic-files-'))
  t.after(() => rm(directory, { recursive: true }))
  const passwordFile = join(directory, 'password.json')
  await writeFile(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const filePath = fileURLToPath(
    new URL('../fixtures/anycubic/journey.gcode.3mf', import.meta.url),
  )
  const name = 'journey.gcode.3mf'

  for (const firmware of ['2.4.6.7', '2.4.6.8']) {
    const sim = await startAnycubicSimulator({
      serial: '20024/device',
      lanFiles: { firmware },
      credentials: { username: 'synthetic', password: 'synthetic' },
    })
    try {
      const bind = (changes: { modelId?: string; uploadPort?: number } = {}) =>
        provisionAnycubicPrinter(
          {
            assignment_id: randomUUID(),
            printer_key: 'printer',
            farm_id: randomUUID(),
            agent_id: randomUUID(),
          },
          {
            printerKey: 'printer',
            host: sim.host,
            port: sim.port,
            uploadPort: sim.uploadPort,
            modelId: '20024',
            deviceId: 'device',
            username: 'synthetic',
            passwordFile,
            pinSha256: createHash('sha256')
              .update(new X509Certificate(sim.syntheticTrust).raw)
              .digest('hex'),
            ...changes,
          },
        )
      const input = {
        binding: bind(),
        signal: AbortSignal.timeout(8000),
        authorized: () => true,
      }
      const upload = { ...input, filePath, name }
      await assert.rejects(
        uploadAnycubicFile({ ...upload, authorized: () => false }),
        { message: 'unauthorized' },
      )
      await assert.rejects(
        listAnycubicFiles({ ...input, binding: bind({ modelId: '20030' }) }),
        { message: 'unsupported' },
      )
      if (firmware !== '2.4.6.7') {
        await assert.rejects(listAnycubicFiles(input), {
          message: 'unsupported',
        })
        await assert.rejects(uploadAnycubicFile(upload), {
          message: 'unsupported',
        })
        assert.equal(sim.uploadCount, 0)
        continue
      }
      await assert.rejects(
        uploadAnycubicFile({
          ...upload,
          binding: bind({ uploadPort: sim.port }),
        }),
        { message: 'unsupported' },
      )
      sim.setPrintProgress(25)
      await assert.rejects(uploadAnycubicFile(upload), { message: 'offline' })
      sim.finishPrint()
      assert.equal(sim.uploadCount, 0)
      assert.deepEqual(await listAnycubicFiles(input), [])
      await uploadAnycubicFile(upload)
      assert.equal(sim.uploadCount, 1)
      const [file] = await listAnycubicFiles(input)
      assert.deepEqual(file && { name: file.name, size: file.size }, {
        name,
        size: (await stat(filePath)).size,
      })
      assert.ok(file && file.modified > 0)
      assert.equal(sim.lifecycle.state, 'finished')
    } finally {
      await sim.close()
    }
  }
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
