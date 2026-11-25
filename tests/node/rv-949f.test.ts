import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { openFixedSdcpControl } from '../../packages/connector/src/sdcp/control-driver.ts'
import { readSdcpHistory } from '../../packages/connector/src/sdcp/history.ts'
import { resolveSdcpTarget } from '../../packages/connector/src/sdcp/identity.ts'
import { openSdcpSession } from '../../packages/connector/src/sdcp/session.ts'
import {
  createSdcpVideo,
  SDCP_CAMERA_DEVICE,
} from '../../packages/connector/src/sdcp/video.ts'
import { printer, RESIN, FIRMWARE } from '../helpers/elegoo-safety.ts'

test('driver refuses camera after firmware changes following detection', async (t) => {
  const world = await printer(t, RESIN)
  const endpoint = {
    host: '127.0.0.1',
    mainboardId: 'board01',
    model: RESIN,
    discoveryPort: world.sim.discoveryPort,
    websocketPort: world.sim.websocketPort,
  }
  const video = createSdcpVideo({
    boards: ['board01'],
    qualified: [{ model: RESIN, firmwareVersion: FIRMWARE }],
  })
  const detected = await resolveSdcpTarget(endpoint, {
    port: endpoint.discoveryPort,
  })
  assert.equal(video.qualified(endpoint, detected.firmwareVersion), true)
  world.sim.discovery.Data.FirmwareVersion = 'V9.9.9'
  const control = openFixedSdcpControl({
    binding: world.binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish() {},
    signal: new AbortController().signal,
    timeoutMs: 300,
    pollMs: 20,
    video,
  })
  t.after(() => control.close())
  await control.prepare()
  await assert.rejects(
    control.driver.execute!(
      'power',
      { device: SDCP_CAMERA_DEVICE, on: true },
      {
        binding: world.binding,
        signal: new AbortController().signal,
        beforeSend: () => true,
      },
    ),
    /not qualified/,
  )
  assert.equal(world.sent().includes(386), false)
})

test('history session rejects commands other than 320 and 321 before sending', async (t) => {
  const world = await printer(t, RESIN)
  const endpoint = {
    host: '127.0.0.1',
    mainboardId: 'board01',
    model: RESIN,
    discoveryPort: world.sim.discoveryPort,
    websocketPort: world.sim.websocketPort,
  }
  const session = await openSdcpSession(endpoint, {
    signal: new AbortController().signal,
    timeoutMs: 100,
  })
  t.after(() => session.close())
  await assert.rejects(
    session.request({ Cmd: 386, Data: {} } as never),
    /read-only/,
  )
  await sleep(30)
  assert.deepEqual(world.sent(), [])
})

test('repeated history reads share a session and close it on disconnect', async (t) => {
  const world = await printer(t, RESIN)
  const endpoint = {
    host: '127.0.0.1',
    mainboardId: 'board01',
    model: RESIN,
    discoveryPort: world.sim.discoveryPort,
    websocketPort: world.sim.websocketPort,
  }
  const controller = new AbortController()
  assert.deepEqual(await readSdcpHistory(endpoint, controller.signal), [])
  assert.equal(world.sim.connected(), 1)
  assert.deepEqual(await readSdcpHistory(endpoint, controller.signal), [])
  assert.equal(world.sim.connected(), 1)
  assert.deepEqual(world.sent(), [320, 320])
  controller.abort()
  await sleep(60)
  assert.equal(world.sim.connected(), 0)
  const next = new AbortController()
  assert.deepEqual(await readSdcpHistory(endpoint, next.signal), [])
  next.abort()
})

test('concurrent history reads share discovery and the session expires', async (t) => {
  const world = await printer(t, RESIN)
  const endpoint = {
    host: '127.0.0.1',
    mainboardId: 'board01',
    model: RESIN,
    discoveryPort: world.sim.discoveryPort,
    websocketPort: world.sim.websocketPort,
  }
  const signal = new AbortController().signal
  assert.deepEqual(
    await Promise.all([
      readSdcpHistory(endpoint, signal),
      readSdcpHistory(endpoint, signal),
    ]),
    [[], []],
  )
  assert.equal(world.sim.connected(), 1)
  await sleep(10200)
  assert.equal(world.sim.connected(), 0)
  assert.deepEqual(await readSdcpHistory(endpoint, signal), [])
  assert.equal(world.sim.connected(), 1)
})
