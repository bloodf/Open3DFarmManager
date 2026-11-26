import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

test('the Connector denies clear_hold even when the operator capability lists it', async (t) => {
  const capabilityModule = new URL(
    '../../packages/farm-protocol/src/pause-capability.ts',
    import.meta.url,
  )
  // Skip only the capability schema's role filters in this test process.
  // Keep the issuer and browser signatures, admission, and dispatcher intact.
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (url !== capabilityModule.href) return loaded
      const source = readFileSync(capabilityModule, 'utf8')
      const receivedRoleFilter =
        /\s*\.refine\(\(\{ role, actions \}\) =>[\s\S]+?(?=\nfunction bounded)/
      assert.equal(source.match(/\.refine\(validRoles\)/g)?.length, 2)
      assert.match(source, receivedRoleFilter)
      return {
        ...loaded,
        source: source
          .replaceAll('.refine(validRoles)', '')
          .replace(receivedRoleFilter, ''),
      }
    },
  })
  const { createV2Authority, nodeSigner, openV2Dispatch } =
    await import('../helpers/command-v2-dispatch.ts').finally(() =>
      hooks.deregister(),
    )
  const authority = await createV2Authority(await nodeSigner())
  const connector = await openV2Dispatch(authority, {
    capability: { actions: ['pause', 'clear_hold'], role: 'operator' },
  })
  t.after(connector.close)
  const result = await connector.dispatch(
    await authority.sign({ action: 'clear_hold', purpose: 'printer-control' }),
  )
  assert.deepEqual(result, { kind: 'rejected', reason: 'scope' })
  assert.equal(connector.claims(), 0)
})

test('an invalid emergency stop cannot abort another user’s readiness probe', async (t) => {
  const { encodeCommandV2 } =
    await import('../../packages/farm-protocol/src/command-v2.ts')
  const { held } = await import('../helpers/restart-hold-dispatch.ts')
  const { createV2Authority, nodeSigner } =
    await import('../helpers/command-v2-dispatch.ts')
  const { f, c } = await held(t, ['firmware_restart'])
  const other = await createV2Authority(await nodeSigner())
  other.ids.account_id = 'account_2'
  for (const field of ['farm_id', 'agent_id', 'assignment_id'] as const)
    other.ids[field] = f.authority.ids[field]
  Object.assign(other.binding, {
    farm_id: other.ids.farm_id,
    agent_id: other.ids.agent_id,
    assignment_id: other.ids.assignment_id,
    account_id: other.ids.account_id,
    connector_public_key_spki: f.authority.binding.connector_public_key_spki,
    connector_fingerprint: f.authority.binding.connector_fingerprint,
  })
  other.connector = f.authority.connector
  const handle = await c.d.admitAs(other)
  c.d.advance(5000)
  const command = other.command(
    {
      action: 'emergency_stop',
      purpose: 'printer-control',
    },
    Math.floor(c.d.now()),
  )
  // The first browser's key cannot sign commands for the second browser.
  const invalid = encodeCommandV2(await f.authority.signer.signCommand(command))
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.printer.hang = true
  f.printer.reading = reading.resolve
  f.printer.holdPrepareOpen = release.promise
  const pause = c.send('pause')
  try {
    await reading.promise
    assert.deepEqual(await c.d.dispatch(invalid, handle), {
      kind: 'rejected',
      reason: 'signature',
    })
  } finally {
    release.resolve()
  }
  assert.equal(await pause, 'applied:applied')
  assert.deepEqual(f.sent, ['firmware_restart', 'pause'])
})
