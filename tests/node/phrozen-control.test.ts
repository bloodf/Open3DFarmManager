import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { connectPhrozen } from '../../packages/connector/src/phrozen/index.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import fixture from '../fixtures/phrozen/synthetic-revo-14k-v153.json' with { type: 'json' }

type Sim = Awaited<ReturnType<typeof startPhrozenSimulator>>
// 129 pause, 130 stop, 131 resume, 128 start, 386 video.
const CONTROL = [128, 129, 130, 131]

async function setup(t: TestContext, firmware = 'V153') {
  const Data = { ...fixture.Data, FirmwareVersion: firmware }
  const sim = await startPhrozenSimulator({ ...fixture, Data })
  t.after(sim.close)
  const printer = await connectPhrozen('127.0.0.1', {
    ...sim,
    timeoutMs: 500,
    confirmTimeoutMs: 150,
    pollMs: 5,
    uploadTimeoutMs: 1000,
  })
  sim.reset()
  return { sim, printer }
}

const info = (sim: Sim) =>
  sim.state().status.PrintInfo as Record<string, unknown>
const sentControls = (sim: Sim) =>
  sim.commands.filter((cmd) => CONTROL.includes(cmd))

async function printing(t: TestContext) {
  const context = await setup(t)
  const taskId = context.sim.beginPrint('part.ctb')
  return { ...context, taskId }
}

test('starts, pauses, resumes and stops, confirmed by reported state', async (t) => {
  const { sim, printer } = await setup(t)
  sim.addFile('part.ctb')

  const started = await printer.start('part.ctb')
  assert.deepEqual(started, {
    outcome: 'confirmed',
    taskId: info(sim).TaskId,
  })
  assert.ok(started.outcome === 'confirmed')
  assert.equal(info(sim).Filename, 'part.ctb')
  assert.deepEqual(sim.state().status.CurrentStatus, [1])
  assert.deepEqual(sim.requests.find((r) => r.cmd === 128)?.data, {
    Filename: 'part.ctb',
    StartLayer: 0,
  })

  assert.equal((await printer.pause(started.taskId)).outcome, 'confirmed')
  assert.equal(info(sim).Status, 6)
  assert.equal((await printer.resume(started.taskId)).outcome, 'confirmed')
  assert.ok([2, 3, 4].includes(info(sim).Status as number))
  assert.equal((await printer.stop(started.taskId)).outcome, 'confirmed')
  assert.equal(info(sim).Status, 8)
  assert.deepEqual(sim.state().status.CurrentStatus, [0])
  assert.deepEqual(sentControls(sim), [128, 129, 131, 130])
})

test('an acknowledgment without a state change is uncertain, sent once, and held', async (t) => {
  const { sim, printer, taskId } = await printing(t)
  sim.misbehave(129, 'ignore')

  assert.deepEqual(await printer.pause(taskId), {
    outcome: 'uncertain',
    reason: 'state-unconfirmed',
  })
  assert.equal(info(sim).Status, 3)
  assert.deepEqual(await printer.stop(taskId), {
    outcome: 'refused',
    reason: 'uncertain-result-unacknowledged',
  })
  assert.deepEqual(sentControls(sim), [129])

  printer.acknowledgeUncertain()
  assert.equal((await printer.stop(taskId)).outcome, 'confirmed')
  assert.equal(info(sim).Status, 8)
})

for (const [behaviour, applied] of [
  ['lost-reply', true],
  ['drop', false],
] as const) {
  test(`a ${behaviour} command is uncertain and never resent`, async (t) => {
    const { sim, printer, taskId } = await printing(t)
    sim.misbehave(129, behaviour)

    assert.deepEqual(await printer.pause(taskId), {
      outcome: 'uncertain',
      reason: 'response-lost',
    })
    assert.equal(info(sim).Status, applied ? 5 : 3)
    assert.deepEqual(sentControls(sim), [129])
  })
}

test('a denied command is refused with the printer reason and no hold', async (t) => {
  const { sim, printer } = await setup(t)
  sim.addFile('part.ctb')
  sim.misbehave(128, 3)

  assert.deepEqual(await printer.start('part.ctb'), {
    outcome: 'refused',
    reason: 'file-md5-failed',
  })
  assert.deepEqual(sim.state().status.CurrentStatus, [0])
  sim.misbehave(128, undefined)
  assert.equal((await printer.start('part.ctb')).outcome, 'confirmed')

  sim.misbehave(129, 1)
  assert.deepEqual(await printer.pause(String(info(sim).TaskId)), {
    outcome: 'refused',
    reason: 'printer-ack-1',
  })
})

test('refuses unsafe commands from reported state without sending them', async (t) => {
  const { sim, printer, taskId } = await printing(t)
  const refusal = (reason: string) => ({ outcome: 'refused', reason })

  for (const wrong of ['other-task', '']) {
    assert.deepEqual(await printer.pause(wrong), refusal('task-mismatch'))
    assert.deepEqual(await printer.stop(wrong), refusal('task-mismatch'))
  }
  assert.deepEqual(await printer.resume(taskId), refusal('not-paused'))
  assert.deepEqual(await printer.start('absent.ctb'), refusal('file-not-found'))
  sim.addFile('part.ctb')
  assert.deepEqual(await printer.start('part.ctb'), refusal('printer-not-idle'))
  for (const name of ['../part.ctb', '/usb/part.ctb', 'a..ctb', ''])
    assert.deepEqual(await printer.start(name), refusal('invalid-filename'))

  sim.endPrint()
  assert.deepEqual(await printer.pause(taskId), refusal('not-printing'))
  assert.deepEqual(await printer.stop(taskId), refusal('not-printing'))
  assert.deepEqual(sentControls(sim), [])
})

test('does not resume a paused print that reports an error', async (t) => {
  const { sim, printer, taskId } = await printing(t)
  await printer.pause(taskId)
  assert.equal(info(sim).Status, 6)
  sim.setPrintInfo({ ErrorNumber: 2 })

  assert.deepEqual(await printer.resume(taskId), {
    outcome: 'refused',
    reason: 'print-error-reported',
  })
  assert.equal(info(sim).Status, 6)
  assert.equal(sim.commands.includes(131), false)
})

test('requires the capability the printer itself reports', async (t) => {
  const { sim, printer, taskId } = await printing(t)
  sim.attributes.Capabilities = []
  const refusal = {
    outcome: 'refused',
    reason: 'capability-not-reported',
  }
  assert.deepEqual(await printer.pause(taskId), refusal)
  assert.deepEqual(await printer.upload('a.ctb', Buffer.from('a')), refusal)
  assert.deepEqual(await printer.enableVideo(), refusal)

  sim.attributes.Capabilities = ['PRINT_CONTROL']
  sim.attributes.FirmwareVersion = 'V999'
  assert.deepEqual(await printer.pause(taskId), {
    outcome: 'refused',
    reason: 'identity-changed',
  })
  sim.misbehave(1, 'drop')
  assert.deepEqual(await printer.pause(taskId), {
    outcome: 'refused',
    reason: 'attributes-unavailable',
  })
  assert.deepEqual(sentControls(sim), [])
  assert.equal(sim.state().uploads.length, 0)
})

test('a command that never left is refused, not uncertain', async (t) => {
  const { sim } = await setup(t)
  // Nothing listens on the control port.
  const unreachable = await connectPhrozen('127.0.0.1', {
    udpPort: sim.udpPort,
    wsPort: 1,
    timeoutMs: 500,
  })

  assert.deepEqual(await unreachable.disableVideo(), {
    outcome: 'refused',
    reason: 'not-sent',
  })
  assert.deepEqual(sim.commands, [])
})

test('runs one state-changing operation at a time', async (t) => {
  const { sim, printer, taskId } = await printing(t)
  const first = printer.pause(taskId)

  assert.deepEqual(await printer.stop(taskId), {
    outcome: 'refused',
    reason: 'operation-in-progress',
  })
  assert.equal((await first).outcome, 'confirmed')
  assert.deepEqual(sentControls(sim), [129])
})

test('uploads in 1 MiB packets and confirms from the file list', async (t) => {
  const { sim, printer } = await setup(t)
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 7)

  const result = await printer.upload('big.ctb', bytes)

  assert.equal(result.outcome, 'confirmed')
  assert.ok(sim.state().files.get('big.ctb')?.equals(bytes))
  const { uploads } = sim.state()
  assert.deepEqual(
    uploads.map((part) => part.offset),
    [0, 1024 * 1024, 2 * 1024 * 1024],
  )
  assert.equal(new Set(uploads.map((part) => part.uuid)).size, 1)
  assert.deepEqual(sentControls(sim), [], 'upload never starts a print')
})

for (const [behaviour, outcome, reason] of [
  ['reject', 'refused', 'upload-rejected'],
  ['ignore', 'uncertain', 'file-unconfirmed'],
  ['lost-reply', 'uncertain', 'upload-response-lost'],
] as const) {
  test(`upload ${behaviour} ends ${outcome} without a resend`, async (t) => {
    const { sim, printer } = await setup(t)
    sim.misbehaveUpload(behaviour)

    assert.deepEqual(await printer.upload('part.ctb', Buffer.from('slice')), {
      outcome,
      reason,
    })
    assert.equal(sim.state().uploads.length, 1)
    // A lost reply hides a stored file; the other two stored nothing.
    assert.equal(sim.state().files.has('part.ctb'), behaviour === 'lost-reply')
  })
}

test('refuses uploads that could overwrite or disturb the printer', async (t) => {
  const { sim, printer } = await setup(t)
  const original = Buffer.from('original')
  sim.addFile('part.ctb', original)
  const send = (name: string, bytes = Buffer.from('new')) =>
    printer.upload(name, bytes)
  const refusal = (reason: string) => ({ outcome: 'refused', reason })

  assert.deepEqual(await send('part.ctb'), refusal('file-exists'))
  assert.deepEqual(await send('../x.ctb'), refusal('invalid-filename'))
  assert.deepEqual(await send('x.exe'), refusal('file-type-not-reported'))
  assert.deepEqual(await send('ctb'), refusal('file-type-not-reported'))
  assert.deepEqual(
    await send('x.ctb', Buffer.alloc(0)),
    refusal('invalid-file-size'),
  )
  sim.beginPrint('part.ctb')
  assert.deepEqual(await send('x.ctb'), refusal('printer-not-idle'))
  assert.equal(sim.state().uploads.length, 0)
  assert.ok(sim.state().files.get('part.ctb')?.equals(original))
})

test('enables and disables the reported RTSP stream', async (t) => {
  const { sim, printer } = await setup(t)

  assert.deepEqual(await printer.enableVideo(), {
    outcome: 'confirmed',
    url: sim.video.url,
  })
  assert.equal(sim.state().videoEnabled, true)
  assert.deepEqual(await printer.disableVideo(), { outcome: 'acknowledged' })
  assert.equal(sim.state().videoEnabled, false)
})

test('refuses video the printer cannot serve', async (t) => {
  const { sim, printer } = await setup(t)
  const refusal = (reason: string) => ({ outcome: 'refused', reason })

  sim.attributes.CameraStatus = 0
  assert.deepEqual(await printer.enableVideo(), refusal('camera-not-reported'))
  sim.attributes.CameraStatus = 1
  sim.attributes.NumberOfVideoStreamConnected = 1
  assert.deepEqual(await printer.enableVideo(), refusal('stream-limit-reached'))
  assert.equal(sim.commands.includes(386), false)
  sim.attributes.NumberOfVideoStreamConnected = 0
  sim.misbehave(386, 3)
  assert.deepEqual(await printer.enableVideo(), refusal('camera-error'))
  assert.equal(sim.state().videoEnabled, false)
})

test('refuses video on V138, which predates the streaming release note', async (t) => {
  const { sim, printer } = await setup(t, 'V138')

  assert.deepEqual(await printer.enableVideo(), {
    outcome: 'refused',
    reason: 'firmware-without-streaming',
  })
  assert.equal(sim.commands.includes(386), false)
  assert.equal(sim.state().videoEnabled, false)
})

for (const url of [
  'rtsp://192.0.2.99:554/video',
  'http://127.0.0.1/video',
  'rtsp://user:pass@127.0.0.1/video',
  'not a url',
]) {
  test(`withholds the video address ${url}`, async (t) => {
    const { sim, printer } = await setup(t)
    sim.video.url = url

    assert.deepEqual(await printer.enableVideo(), {
      outcome: 'uncertain',
      reason: 'video-url-rejected',
    })
  })
}

for (const model of [
  'Sonic Mighty Revo 16K MAX',
  'Sonic Mighty Revo 16K',
  'Sonic Mighty 8K',
  'Sonic Mini 8K S',
]) {
  test(`exposes no operation for ${model}`, async (t) => {
    const sim = await startPhrozenSimulator({
      ...fixture,
      Data: { ...fixture.Data, MachineName: model },
    })
    t.after(sim.close)

    await assert.rejects(
      connectPhrozen('127.0.0.1', sim),
      /Unsupported Phrozen SDCP/,
    )
    assert.deepEqual(sim.commands, [])
  })
}
