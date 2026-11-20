import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('self-hosting upgrade guide gives one canonical entry point per procedure step', async () => {
  const guide = await readFile(
    new URL('../../docs/SELF-HOSTING-UPGRADE.md', import.meta.url),
    'utf8',
  )

  assert.match(
    guide,
    /## 1\. Rehearse[\s\S]*?scripts\/self-host\/rehearse-upgrade\.ts/,
  )
  assert.match(guide, /## 3\. Upgrade[\s\S]*?scripts\/self-host\/upgrade\.ts/)
  assert.match(
    guide,
    /## 4\. Migrate Connector[\s\S]*?scripts\/connector-config-migrate\.ts/,
  )
  const rollback = guide.split('## 6. Roll back')[1]
  assert.ok(rollback)
  assert.match(rollback, /Stop all application processes and Connectors/)
  assert.match(rollback, /restore\.ts fence \/private\/connector\/state/)
  assert.match(
    rollback,
    /restore\.ts restore postgres rollback_v1 \/private\/backups\/pre-v2\.dump provisioning \/private\/backups\/connector\.json \/private\/connector\/restored\.json \/private\/connector\/state/,
  )
  assert.match(
    rollback,
    /revokes sessions and browser keys[\s\S]*fences[\s\S]*before allowing ordinary database connections/,
  )
  assert.match(rollback, /If any step fails, keep access closed/)
  assert.match(rollback, /Reopen access only after every check succeeds/)
  assert.match(rollback, /discards writes made after the backup/)
  assert.doesNotMatch(guide, /scripts\/self-host-upgrade\.ts/)
  assert.equal(
    (guide.match(/scripts\/self-host\/rehearse-upgrade\.ts/g) ?? []).length,
    1,
  )
  assert.equal(
    (guide.match(/scripts\/self-host\/upgrade\.ts/g) ?? []).length,
    2,
  ) // dry run and execution
})
