import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForBrowserCapture } from '../helpers/pairing-http-capture.ts'

test('browser capture reports a stalled response instead of hanging', async () => {
  await waitForBrowserCapture([Promise.resolve()], 100)
  await assert.rejects(
    waitForBrowserCapture([new Promise<void>(() => {})], 20),
    /Browser response capture timed out/,
  )
})
