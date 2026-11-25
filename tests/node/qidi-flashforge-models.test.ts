import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createQidiAdapter } from '../../packages/connector/src/qidi/index.ts'
import {
  createFlashforgeAdapter,
  discoverFlashforge,
} from '../../packages/connector/src/flashforge/index.ts'
import { startQidiSimulator } from '../../packages/sim-tools/src/qidi-simulator.ts'
import { startStatefulFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'
import {
  flashforgeModels,
  unsupportedFlashforgeModels,
} from '../fixtures/flashforge/models.ts'
import { qidiModels } from '../fixtures/qidi/models.ts'
import moonraker from '../fixtures/qidi/moonraker.json' with { type: 'json' }

const snapshot = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

for (const { name, namedFan } of qidiModels) {
  test(`Qidi ${name}: reads Moonraker and stores an upload without starting it`, async (t) => {
    const { fan, ...common } = moonraker.state.result.status
    const status = namedFan
      ? {
          ...common,
          'fan_generic cooling_fan': fan,
          'fan_generic chamber_circulation_fan': { speed: 0.9 },
        }
      : common
    const sim = await startQidiSimulator({
      ...moonraker,
      state: { result: { ...moonraker.state.result, status } },
      snapshot,
    })
    t.after(() => sim.close())

    const auth = { apiKey: 'fixture-key' }
    const adapter = createQidiAdapter({
      origin: sim.origin,
      auth,
      snapshotPath: '/webcam/?action=snapshot',
    })
    assert.deepEqual(await adapter.discover(), {
      moonrakerVersion: 'v0.8.0',
      klippyConnected: true,
      klippyState: 'ready',
    })
    const expected = {
      webhooks: common.webhooks,
      printStats: common.print_stats,
      virtualSdcard: common.virtual_sdcard,
      extruder: common.extruder,
      heaterBed: common.heater_bed,
      fan: namedFan ? fan : undefined,
    }
    assert.deepEqual(await adapter.readState(), expected)
    assert.deepEqual(await adapter.readHistory(), moonraker.history.result.jobs)
    assert.deepEqual(await adapter.readSnapshot(), snapshot)

    const directory = await mkdtemp(join(tmpdir(), 'openfarm-qidi-model-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const filename = 'new model.gcode'
    const filePath = join(directory, filename)
    const content = '; upload fixture\n'
    await writeFile(filePath, content)
    const readFile = () =>
      fetch(
        new URL(
          `/server/files/gcodes/${encodeURIComponent(filename)}`,
          sim.origin,
        ),
        { headers: { 'X-Api-Key': auth.apiKey } },
      )
    const before = await readFile()
    assert.equal(before.status, 404)
    await before.body?.cancel()
    await adapter.upload({
      filePath,
      name: filename,
      signal: new AbortController().signal,
    })
    const stored = await readFile()
    assert.equal(stored.status, 200)
    assert.equal(await stored.text(), content)
    assert.deepEqual(await adapter.readState(), expected)
  })
}

const authorize = () => true

for (const fixture of flashforgeModels) {
  for (const firmware of fixture.firmware) {
    test(`Flashforge ${fixture.name} ${firmware}: reports model state and operation outcomes`, async (t) => {
      const sim = await startStatefulFlashforgeSimulator({
        ...fixture,
        detail: { ...fixture.detail, firmwareVersion: `v${firmware}` },
      })
      t.after(() => sim.close())
      assert.deepEqual(
        await discoverFlashforge({ host: sim.host, port: sim.discoveryPort }),
        {
          model: fixture.name,
          serialNumber: 'FIXTURE-SERIAL',
        },
      )
      const adapter = createFlashforgeAdapter({
        ...sim,
        cameraPort: sim.port,
        serialNumber: 'FIXTURE-SERIAL',
        checkCode: 'fixture01',
      })
      const signal = new AbortController().signal
      const initial = await adapter.readStatus()
      assert.equal(initial.model, fixture.name)
      assert.equal(initial.firmware, firmware)
      assert.equal(initial.status, 'ready')
      assert.deepEqual(initial.nozzle, { current: 205, target: 210 })
      assert.deepEqual(initial.bed, { current: 58, target: 60 })
      assert.equal(initial.coolingFanPercent, 70)
      assert.deepEqual(
        initial.filtration,
        fixture.pid === 36
          ? { internal: 'open', external: 'close' }
          : undefined,
      )
      assert.equal(initial.material, 'PLA')
      assert.equal(initial.estimatedGrams, 12.5)
      assert.equal(initial.errorCode, 'E0048')
      assert.deepEqual(await adapter.listFiles(), fixture.files)
      if (fixture.pid === 35) {
        await assert.rejects(adapter.openCamera(signal), /camera unavailable/)
      } else {
        const camera = await adapter.openCamera(signal)
        assert.equal(
          camera.contentType,
          'multipart/x-mixed-replace; boundary=fixture',
        )
        assert.match(await new Response(camera.body).text(), /fixture-frame/)
      }

      const filename = 'new.gcode'
      const upload = {
        kind: 'upload',
        filename,
        content: Buffer.from('; fixture\n'),
      } as const
      const start = { kind: 'start', filename } as const
      if (fixture.pid === 38) {
        assert.deepEqual(initial.slots, [
          { id: 0, loaded: false, material: undefined, color: undefined },
          { id: 3, loaded: true, material: 'PETG', color: '#113355' },
        ])
        for (const action of [
          upload,
          start,
          { kind: 'pause' },
          { kind: 'resume' },
          { kind: 'cancel' },
          { kind: 'temperature', heater: 'nozzle', celsius: 195 },
          { kind: 'fan', percent: 40 },
        ] as const) {
          await assert.rejects(
            adapter.execute(action, authorize),
            /unavailable on AD5X/,
          )
        }
        assert.deepEqual(await adapter.readStatus(), initial)
        assert.deepEqual(await adapter.listFiles(), fixture.files)
        return
      }
      assert.equal(initial.slots, undefined)
      await adapter.execute(upload, authorize)
      assert.deepEqual(await adapter.listFiles(), [...fixture.files, filename])
      assert.deepEqual(await adapter.readStatus(), initial)
      await adapter.execute(start, authorize)
      const started = await adapter.readStatus()
      assert.equal(started.status, 'printing')
      assert.equal(started.filename, filename)
      assert.equal(started.progress, 0)
      await adapter.execute({ kind: 'fan', percent: 40 }, authorize)
      assert.equal((await adapter.readStatus()).coolingFanPercent, 40)
      await adapter.execute(
        { kind: 'temperature', heater: 'nozzle', celsius: 195 },
        authorize,
      )
      assert.deepEqual((await adapter.readStatus()).nozzle, {
        current: 205,
        target: 195,
      })
      await adapter.execute(
        { kind: 'temperature', heater: 'bed', celsius: 0 },
        authorize,
      )
      assert.deepEqual((await adapter.readStatus()).bed, {
        current: 58,
        target: 0,
      })
      await adapter.execute({ kind: 'pause' }, authorize)
      assert.equal((await adapter.readStatus()).status, 'pause')
      await adapter.execute({ kind: 'resume' }, authorize)
      assert.equal((await adapter.readStatus()).status, 'printing')
      await adapter.execute({ kind: 'cancel' }, authorize)
      const cancelled = await adapter.readStatus()
      assert.equal(cancelled.status, 'cancel')
      assert.equal(cancelled.filename, undefined)
    })
  }
}

for (const { name, pid } of unsupportedFlashforgeModels) {
  test(`Flashforge ${name}: rejects out-of-contract PID`, async (t) => {
    const sim = await startStatefulFlashforgeSimulator({
      pid,
      detail: { pid },
      files: [],
    })
    t.after(() => sim.close())
    const adapter = createFlashforgeAdapter({
      ...sim,
      serialNumber: 'FIXTURE-SERIAL',
      checkCode: 'fixture01',
    })
    await assert.rejects(
      discoverFlashforge({ host: sim.host, port: sim.discoveryPort }),
      /Unsupported Flashforge model/,
    )
    await assert.rejects(adapter.readStatus(), /Unsupported Flashforge model/)
  })
}
