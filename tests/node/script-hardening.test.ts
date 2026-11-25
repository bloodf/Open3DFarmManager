import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { verifyWebhook } from '../../examples/integration-client/client.ts'

test('webhook signatures outside the five minute window are rejected', () => {
  const body = Buffer.from('event')
  const timestamp = String(Math.floor(Date.now() / 1000) - 6 * 60)
  const signature = createHmac('sha256', 'secret')
    .update(timestamp + '.')
    .update(body)
    .digest('hex')
  assert.equal(
    verifyWebhook(body, timestamp, `v1=${signature}`, 'secret'),
    false,
  )
})

test('worker ledger is private and refuses symlink targets', async () => {
  const { createWorkerLedger } = createRequire(import.meta.url)(
    '../../scripts/worker-ledger.mjs',
  ) as {
    createWorkerLedger: (directory: string) => (data: object) => void
  }
  const root = mkdtempSync(join(tmpdir(), 'ledger-test-'))
  try {
    const ledger = createWorkerLedger(join(root, 'private'))
    ledger({ action: 'created' })
    assert.equal(statSync(join(root, 'private')).mode & 0o777, 0o700)
    assert.equal(
      statSync(join(root, 'private', 'worker-ledger.jsonl')).mode & 0o777,
      0o600,
    )
    assert.match(
      readFileSync(join(root, 'private', 'worker-ledger.jsonl'), 'utf8'),
      /created/,
    )
    const link = join(root, 'linked')
    symlinkSync(join(root, 'outside'), link)
    assert.throws(() => createWorkerLedger(link))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
