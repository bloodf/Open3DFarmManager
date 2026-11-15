import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMoonrakerSocket } from '../../packages/connector/src/moonraker/socket.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'
import {
  listMoonrakerMacros,
  supportedMoonrakerFilamentActions,
  buildMoonrakerMacroCommand,
} from '../../packages/connector/src/moonraker/macros.ts'

test('lists advertised safe macros and executes only those names', async () => {
  const objects = [
    'gcode_macro Z',
    'gcode_macro A',
    'gcode_macro _HIDDEN',
    'gcode_macro LOAD_FILAMENT',
    'gcode_macro UNLOAD_FILAMENT',
    'gcode_macro BAD\nM112',
  ]
  const fixture = await pauseFixture({ objects })
  const ws = createMoonrakerSocket(fixture.origin, {
    maxMessageBytes: 4096,
    connectTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    staleAfterMs: 1000,
    reconnectMinMs: 100,
    reconnectMaxMs: 1000,
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let id = 0
  const request = (call: object) =>
    new Promise<any>((resolve) => {
      const current = ++id
      const handler = (data: Buffer) => {
        const message = JSON.parse(data.toString())
        if (message.id === current) {
          ws.off('message', handler)
          resolve(message)
        }
      }
      ws.on('message', handler)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: current, ...call }))
    })
  try {
    const reply = await request({ method: 'printer.objects.list' })
    const listed = reply.result.objects
    assert.deepEqual(listMoonrakerMacros(listed), ['A', 'Z'])
    assert.deepEqual(supportedMoonrakerFilamentActions(listed), [
      'load_filament',
      'unload_filament',
    ])
    for (const call of [
      buildMoonrakerMacroCommand('run_macro', { name: 'A' }, listed),
      buildMoonrakerMacroCommand('load_filament', {}, listed),
      buildMoonrakerMacroCommand('unload_filament', {}, listed),
    ])
      assert.equal((await request(call)).result, 'ok')
    assert.deepEqual(fixture.gcodeScripts, [
      'A',
      'LOAD_FILAMENT',
      'UNLOAD_FILAMENT',
    ])
    for (const name of [
      '_HIDDEN',
      'BAD\nM112',
      'A\nM112',
      'LOAD_FILAMENT',
      'UNKNOWN',
    ])
      assert.throws(() =>
        buildMoonrakerMacroCommand('run_macro', { name }, listed),
      )
    assert.throws(() => buildMoonrakerMacroCommand('load_filament', {}, []))
    assert.throws(() =>
      buildMoonrakerMacroCommand(
        'run_macro',
        { name: 'A', params: 'M112' },
        listed,
      ),
    )
    assert.equal(
      listMoonrakerMacros(
        Array.from({ length: 60 }, (_, i) => `gcode_macro M${i}`),
      ).length,
      50,
    )
  } finally {
    ws.terminate()
    await fixture.close()
  }
})
