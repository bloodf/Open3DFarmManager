import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { encodePauseCapability } from '../../packages/farm-protocol/src/pause-capability.ts'
import { issueBrowserCapability as issue } from '../helpers/postgres-browser-capability.ts'

// Frozen from the last protocol before #787. The issuer and test run against
// current code, while the Connector's admission decoder uses the old enum.
const previousActions = [
  'pause',
  'resume',
  'cancel',
  'emergency_stop',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'start_print',
  'start_library_print',
  'firmware_restart',
  'service',
  'power',
  'timelapse',
  'run_macro',
  'config_write',
  'load_filament',
  'unload_filament',
  'jog',
  'motors_off',
  'z_babystep',
  'set_factor',
  'extrude',
  'file_op',
  'exclude_object',
  'set_led',
  'set_pin',
  'queue_op',
  'bed_mesh',
  'gcode',
  'confirm_collection',
] as const
const protocolUrl = new URL(
  '../../packages/farm-protocol/src/pause-capability.ts',
  import.meta.url,
).href
const previousModule =
  'data:text/javascript,' +
  encodeURIComponent(`
  import { decodePauseCapability as decode, SignedPauseCapabilityV1 } from ${JSON.stringify(protocolUrl)}
  export * from ${JSON.stringify(protocolUrl)}
  export function decodePauseCapability(input) {
    const capability = JSON.parse(input)
    if (capability.actions.some(action => !${JSON.stringify(previousActions)}.includes(action))) {
      throw new Error('Unsupported action in legacy capability')
    }
    return SignedPauseCapabilityV1.parse(decode(input))
  }
`)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    if (
      context.parentURL?.endsWith('/connector/src/auth/pause-capability.ts') &&
      resolved.url === protocolUrl
    )
      return { url: previousModule, shortCircuit: true }
    return resolved
  },
})
const { createV2Authority, nodeSigner, openV2Dispatch } =
  await import('../helpers/command-v2-dispatch.ts').finally(() =>
    hooks.deregister(),
  )

test('the new issuer capability is admitted by the previous action enum and dispatches pause', async (t) => {
  const fixture = await createV2Authority(await nodeSigner())
  let actions: string[] | undefined
  let capabilityId: string | undefined
  const dispatcher = await openV2Dispatch(fixture, {
    now: 2000,
    async capabilityWire(claims) {
      const issued = await issue(fixture, claims, [
        'pause',
        'resume',
        'cancel',
        'emergency_stop',
        'set_temperature',
        'power',
        'future_action',
      ])
      assert.ok(issued.ok)
      actions = issued.capability.actions
      capabilityId = issued.capability.capability_id
      return encodePauseCapability(issued.capability)
    },
  })
  t.after(() => dispatcher.close())
  assert.deepEqual(actions, [
    'pause',
    'resume',
    'cancel',
    'emergency_stop',
    'set_temperature',
  ])
  assert.ok(capabilityId)
  const result = await dispatcher.dispatch(
    await fixture.sign({ capability_id: capabilityId }, dispatcher.now()),
  )
  assert.equal(result.kind, 'applied')
  assert.equal(dispatcher.writes(), 1)
})

test('only eligible advertised role-allowed actions are signed', async () => {
  const fixture = await createV2Authority(await nodeSigner())
  const dispatcher = await openV2Dispatch(fixture, {
    now: 2000,
    async capabilityWire(claims) {
      const modern = await issue(fixture, claims, [
        'set_tool_temperature',
        'power',
        'future_action',
      ])
      assert.ok(modern.ok)
      assert.deepEqual(modern.capability.actions, ['set_tool_temperature'])
      const legacy = await issue(
        fixture,
        claims,
        ['pause', 'resume', 'cancel', 'emergency_stop', 'set_tool_temperature'],
        null,
      )
      assert.ok(legacy.ok)
      assert.deepEqual(legacy.capability.actions, [
        'pause',
        'cancel',
        'emergency_stop',
      ])
      const empty = await issue(fixture, claims, ['power', 'future_action'])
      assert.deepEqual(empty, { ok: false, reason: 'denied' })
      const missing = await issue(fixture, claims, undefined)
      assert.deepEqual(missing, { ok: false, reason: 'denied' })
      const compatible = await issue(fixture, claims, ['pause'])
      assert.ok(compatible.ok)
      return encodePauseCapability(compatible.capability)
    },
  })
  dispatcher.close()
})
