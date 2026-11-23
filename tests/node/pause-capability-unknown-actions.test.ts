import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { signPauseCapability } from '../../packages/farm-protocol/src/pause-capability.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

test('Connector grants only known actions from a valid future issuer capability', async (t) => {
  const authority = await createV2Authority(await nodeSigner())
  const fixture = await openV2Dispatch(authority, {
    async capabilityWire(claims, key) {
      const futureClaims = { ...claims, actions: ['future_action', 'pause'] }
      // Model an issuer with a newer action enum while using the same signing domain.
      const payload = Buffer.from(
        'Open3DFarmManager/pause-capability/v1\0' + canonicalize(futureClaims),
      )
      const signature = Buffer.from(
        await crypto.subtle.sign('Ed25519', key, payload),
      ).toString('base64url')
      return canonicalize({ ...futureClaims, signature })
    },
  })
  t.after(() => fixture.close())

  assert.deepEqual(fixture.handle.current?.actions, ['pause'])
  assert.equal((await fixture.dispatch(await authority.sign())).kind, 'applied')
  assert.equal(fixture.writes(), 1)
})

test('Connector verifies unknown actions as part of the signed capability', async () => {
  const authority = await createV2Authority(await nodeSigner())
  await assert.rejects(
    openV2Dispatch(authority, {
      async capabilityWire(claims, key) {
        const signed = await signPauseCapability(claims, key)
        return canonicalize({ ...signed, actions: ['future_action', 'pause'] })
      },
    }),
    { message: 'Capability admission failed: signature-rejected' },
  )
})
