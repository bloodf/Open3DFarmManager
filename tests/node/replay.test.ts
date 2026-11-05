import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  chmodSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBrowserKey,
  signCommand,
} from '../../packages/farm-protocol/src/sign.ts'
import { PersistentReplayStore } from '../../packages/connector/src/auth/replay.ts'

const id = '00000000-0000-4000-8000-000000000001'
const input = {
  farm_id: id,
  agent_id: id,
  printer_id: id,
  user_id: id,
  key_id: id,
  session_id: id,
  action: 'pause' as const,
}
function scratch() {
  return mkdtempSync(join(tmpdir(), 'open3d-replay-test-'))
}

test('replay claims persist across restarts and cannot be claimed by a second connection', async () => {
  const directory = scratch()
  const pair = await createBrowserKey()
  const command = await signCommand(input, pair.privateKey, 100_000)
  try {
    const first = new PersistentReplayStore(directory)
    const second = new PersistentReplayStore(directory)
    assert.equal(first.claim(command, 100_000), 'accepted')
    assert.equal(second.claim(command, 100_000), 'replay')
    first.close()
    second.close()
    const reopened = new PersistentReplayStore(directory)
    try {
      assert.equal(reopened.claim(command, 100_000), 'replay')
      assert.equal(
        reopened.claim({ ...command, cmd_id: crypto.randomUUID() }, 100_000),
        'replay',
      )
      assert.equal(
        reopened.claim({ ...command, nonce: 'A'.repeat(22) }, 100_000),
        'replay',
      )
      if (process.platform !== 'win32')
        assert.equal(
          lstatSync(join(directory, 'replay.sqlite')).mode & 0o777,
          0o600,
        )
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test('capacity fails closed without evicting live entries, expiry allows bounded cleanup', async () => {
  const directory = scratch()
  const pair = await createBrowserKey()
  const first = await signCommand(input, pair.privateKey, 100_000)
  const second = await signCommand(input, pair.privateKey, 100_000)
  const store = new PersistentReplayStore(directory, 1)
  try {
    assert.equal(store.claim(first, 100_000), 'accepted')
    assert.equal(store.claim(second, 100_000), 'capacity')
    assert.equal(store.claim(first, 100_000), 'replay')
    const later = await signCommand(input, pair.privateKey, 700_001)
    assert.equal(store.claim(later, 700_001), 'accepted')
    assert.equal(
      store.claim({ ...later, cmd_id: crypto.randomUUID() }, 700_000),
      'clock-regressed',
    )
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test('rate limits count accepted commands atomically per printer', async () => {
  const directory = scratch()
  const pair = await createBrowserKey()
  const store = new PersistentReplayStore(directory)
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        store.claim(
          await signCommand(input, pair.privateKey, 100_000),
          100_000,
        ),
        'accepted',
      )
    assert.equal(
      store.claim(await signCommand(input, pair.privateKey, 100_000), 100_000),
      'rate-limited',
    )
    const emergency = await signCommand(
      { ...input, action: 'emergency_stop' },
      pair.privateKey,
      100_000,
    )
    assert.equal(store.claim(emergency, 100_000), 'accepted')
    assert.equal(store.claim(emergency, 100_000), 'replay')
    assert.equal(
      store.claim(await signCommand(input, pair.privateKey, 160_000), 160_000),
      'accepted',
    )
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test('reject unsafe storage paths without modifying the target', () => {
  const directory = scratch()
  const target = join(directory, 'target')
  writeFileSync(target, 'unchanged')
  try {
    symlinkSync(target, join(directory, 'replay.sqlite'))
    assert.throws(() => new PersistentReplayStore(directory), /private files/)
    if (process.platform !== 'win32') {
      rmSync(join(directory, 'replay.sqlite'))
      chmodSync(directory, 0o755)
      assert.throws(() => new PersistentReplayStore(directory), /private/)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
