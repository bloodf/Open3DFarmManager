// Loopback simulator only. Upload outcomes are asserted from the files and
// printer state the simulator holds, never from the request being sent.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { provisionSdcpPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  supportsFileUpload,
  uploadFile,
} from '../../packages/connector/src/runtime/file-upload.ts'
import { openFixedSdcpControl } from '../../packages/connector/src/sdcp/control-driver.ts'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'

async function world(
  t: TestContext,
  model: string,
  size = 2 * 1024 * 1024 + 512 * 1024,
) {
  const family = model === 'Centauri Carbon' ? 'fdm' : 'resin'
  const sim = await startSdcpSimulator({
    Id: 'fixture',
    Data: {
      Name: 'Test',
      MachineName: model,
      MainboardIP: '127.0.0.1',
      MainboardID: 'board01',
      ProtocolVersion: 'V3.0.0',
      FirmwareVersion: 'V1.0.0',
    },
  })
  t.after(sim.close)
  const machine = sim.simulate({ family })
  const directory = mkdtempSync(join(tmpdir(), 'sdcp-upload-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'staged')
  const bytes = randomBytes(size)
  writeFileSync(filePath, bytes)
  const printer_key = 'elegoo'
  const binding = provisionSdcpPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key,
    },
    {
      printerKey: printer_key,
      host: '127.0.0.1',
      mainboardId: 'board01',
      model,
      discoveryPort: sim.discoveryPort,
      websocketPort: sim.websocketPort,
      uploadPort: sim.websocketPort,
    },
  )
  const upload = (name: string, authorize = () => true) =>
    uploadFile({
      target: { backend: 'sdcp', binding },
      filePath,
      name,
      signal: new AbortController().signal,
      authorize,
    })
  return { sim, machine, binding, bytes, filePath, upload }
}

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')

for (const [model, name] of [
  ['Saturn 4 Ultra', 'part.ctb'],
  ['Saturn 4 Ultra 16K', 'part.goo'],
  ['Mars 5 Ultra', 'a part.goo'],
  ['Centauri Carbon', 'part.gcode'],
] as const) {
  // Resin files start only as a validated library version, never by name.
  const starts = model === 'Centauri Carbon'
  test(`${model} stores a chunked upload and ${starts ? 'starts' : 'refuses a bare start of'} the stored file`, async (t) => {
    const { sim, machine, binding, bytes, upload } = await world(t, model)
    await upload(name)
    assert.equal(sha(machine.files.get(name)!), sha(bytes))
    assert.equal(machine.transferring, false)
    assert.equal(machine.phase, 'idle', 'an upload never starts a print')
    assert.deepEqual(
      sim.chunks.map(({ offset, size }) => [offset, size]),
      [
        [0, 1048576],
        [1048576, 1048576],
        [2097152, 524288],
      ],
    )
    assert.equal(new Set(sim.chunks.map(({ uuid }) => uuid)).size, 1)

    const seen: ControlObservation[] = []
    const control = openFixedSdcpControl({
      binding,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: (observation) => observation && seen.push(observation),
      signal: new AbortController().signal,
      // The shipped list is empty; this qualifies the simulator.
      qualifiedStarts: [{ model, firmwareVersion: 'V1.0.0' }],
    })
    t.after(() => control.close())
    await control.prepare()
    const start = control.driver.execute!(
      'start_print',
      { file: name },
      {
        binding,
        signal: new AbortController().signal,
        beforeSend: () => true,
      },
    )
    if (!starts) {
      await assert.rejects(start, /resin-artifact-requires-library-version/)
      assert.equal(machine.phase, 'idle')
      return
    }
    await start
    assert.equal(seen.at(-1)?.printState, 'printing')
    assert.equal(machine.filename, name)
  })
}

test('file types are limited to the model that prints them', async (t) => {
  const resin = await world(t, 'Saturn 4 Ultra', 16)
  const carbon = await world(t, 'Centauri Carbon', 16)
  for (const [printer, name] of [
    [resin, 'part.gcode'],
    [resin, 'dir/part.ctb'],
    [resin, '..ctb'],
    [resin, 'a"b.ctb'],
    [carbon, 'part.ctb'],
    [carbon, 'part.3mf'],
  ] as const) {
    assert.equal(
      supportsFileUpload(
        { backend: 'sdcp', binding: printer.binding },
        name,
        true,
      ),
      false,
    )
    await assert.rejects(printer.upload(name), /unsupported/)
    assert.equal(printer.sim.chunks.length, 0)
  }
})

test('a rejected chunk ends the upload without a retry or a stored file', async (t) => {
  const { sim, machine, upload } = await world(t, 'Saturn 4 Ultra')
  machine.fault = { rejectOffset: 1048576 }
  await assert.rejects(upload('part.ctb'), /rejected at offset 1048576/)
  assert.deepEqual(
    sim.chunks.map(({ offset }) => offset),
    [0, 1048576],
  )
  assert.equal(machine.files.size, 0)
})

test('authorization is rechecked before every chunk', async (t) => {
  const { sim, machine, upload } = await world(t, 'Centauri Carbon')
  await assert.rejects(
    upload('part.gcode', () => sim.chunks.length < 1),
    /unauthorized/,
  )
  assert.equal(sim.chunks.length, 1)
  assert.equal(machine.files.size, 0)
})

test('nothing is uploaded when the board behind the address changed', async (t) => {
  const { sim, upload } = await world(t, 'Saturn 4 Ultra', 16)
  sim.discovery.Data.MainboardID = 'replaced'
  await assert.rejects(upload('part.ctb'), /identity/)
  assert.equal(sim.chunks.length, 0)
})
