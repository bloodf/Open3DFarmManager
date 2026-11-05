import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { captureFixtureStderr } from '../helpers/telemetry-fixture-diagnostic.ts'

test('fixture failure capture records bounded redacted child diagnostics', async () => {
  const secret = 'S3CR3T_key-never-log-this'
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stderr.write('cause: synthetic failure\\n' + process.argv[1] + '\\n' + 'x'.repeat(12000)); process.exitCode = 7",
      secret,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const finish = captureFixtureStderr(child.stderr, [secret])
  const [code, signal] = await once(child, 'exit')
  const result = finish()
  assert.equal(code, 7)
  assert.equal(signal, null)
  assert.match(result.text, /cause: synthetic failure/)
  assert.ok(!result.text.includes(secret))
  assert.ok(!result.text.includes(secret.slice(0, 8)))
  assert.ok(result.text.length <= 8192)
  assert.equal(result.truncated, true)
})
