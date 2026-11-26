import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { held } from '../helpers/restart-hold-dispatch.ts'

test(
  'a genuine stop reaches the driver while a bad signature is still being verified',
  { timeout: 5000 },
  async (t) => {
    const { f, c } = await held(t, ['firmware_restart'])
    c.d.advance(5000)
    const valid = await c.wire('emergency_stop')
    const command = decodeCommandV2(await c.wire('emergency_stop'))
    const badSignature = new Uint8Array(64)
    const invalid = encodeCommandV2({
      ...command,
      sig: Buffer.from(badSignature).toString('base64url'),
    })
    const verifying = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const verify = crypto.subtle.verify.bind(crypto.subtle)
    t.mock.method(
      crypto.subtle,
      'verify',
      async (...args: Parameters<SubtleCrypto['verify']>) => {
        if (
          ArrayBuffer.isView(args[2]) &&
          Buffer.from(
            args[2].buffer,
            args[2].byteOffset,
            args[2].byteLength,
          ).equals(badSignature)
        ) {
          verifying.resolve()
          await release.promise
        }
        return verify(...args)
      },
    )
    const reading = Promise.withResolvers<void>()
    f.printer.hang = true
    f.printer.reading = reading.resolve
    const pause = c.send('pause')
    await reading.promise
    const bad = c.d.dispatch(invalid)
    try {
      await verifying.promise
      const stop = await c.d.dispatch(valid)
      assert.deepEqual(f.sent, ['firmware_restart', 'emergency_stop'])
      assert.equal(stop.kind, 'outcome-unknown')
      assert.equal(stop.reason, 'state-unconfirmed')
      assert.equal(await pause, 'rejected:busy')
    } catch (error) {
      c.d.dispatcher.close()
      await pause
      throw error
    } finally {
      release.resolve()
    }
    assert.deepEqual(await bad, { kind: 'rejected', reason: 'signature' })
  },
)

test(
  'concurrent copies of a verified stop send only once',
  { timeout: 5000 },
  async (t) => {
    const { f, c } = await held(t, ['firmware_restart'])
    c.d.advance(5000)
    const wire = await c.wire('emergency_stop')
    const reading = Promise.withResolvers<void>()
    const closing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.printer.hang = true
    f.printer.reading = reading.resolve
    f.printer.closing = closing.resolve
    f.printer.holdCloseOpen = release.promise
    const pause = c.send('pause')
    await reading.promise
    // Both copies must pass verification and wait on the probe before it ends.
    const verified = Promise.withResolvers<void>()
    const verify = crypto.subtle.verify.bind(crypto.subtle)
    let verifications = 0
    t.mock.method(
      crypto.subtle,
      'verify',
      async (...args: Parameters<SubtleCrypto['verify']>) => {
        const valid = await verify(...args)
        if (++verifications === 2) verified.resolve()
        return valid
      },
    )
    const first = c.d.dispatch(wire)
    await closing.promise
    let repeatSettled = false
    const repeat = c.d.dispatch(wire).then((result) => {
      repeatSettled = true
      return result
    })
    try {
      await Promise.resolve()
      assert.equal(
        repeatSettled,
        false,
        'the repeat can verify during probe shutdown',
      )
      await verified.promise
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      release.resolve()
      await Promise.all([first, repeat, pause])
    }
    const results = await Promise.all([first, repeat])
    assert.deepEqual(
      results.map((result) => `${result.kind}:${result.reason}`).sort(),
      ['outcome-unknown:state-unconfirmed', 'rejected:busy'],
    )
    assert.equal(await pause, 'rejected:busy')
    assert.deepEqual(f.sent, ['firmware_restart', 'emergency_stop'])
  },
)
