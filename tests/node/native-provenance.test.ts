import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  verifyInstalledNative,
  verifyNative,
} from '../../packages/connector/verify-native.mjs'

test('rejects altered and unsupported native binaries', () => {
  assert.throws(
    () => verifyNative('linux-x64-gnu', Buffer.from('altered')),
    /Unverified/,
  )
  assert.throws(
    () => verifyNative('unknown', Buffer.from('anything')),
    /Unverified/,
  )
})

test('verifies the installed prebuilt selected by the Connector', () => {
  assert.doesNotThrow(() => verifyInstalledNative())
})
