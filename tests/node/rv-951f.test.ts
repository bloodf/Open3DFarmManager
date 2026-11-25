import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

const dispatcherSource = new URL(
  '../../packages/connector/src/control/pause-dispatcher.ts',
  import.meta.url,
)

test('the emergency stop preemption runs after signature and live scope checks', () => {
  const source = readFileSync(dispatcherSource, 'utf8')
  const dispatch = source.slice(source.indexOf('    dispatch(input:'))
  const signatureCheck = dispatch.indexOf('!(await verifyCommandV2(')
  const scopeCheck = dispatch.indexOf('denial = live()', signatureCheck)
  const preemption = dispatch.match(
    /await waitForProbe\(probe\)|return preempt\(\)/,
  )

  assert.match(dispatch, /!controlRoleAllowed\(cap.role, command.action\)/)
  assert.ok(signatureCheck >= 0)
  assert.ok(scopeCheck > signatureCheck)
  assert.ok(preemption?.index !== undefined && preemption.index > scopeCheck)
})

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
