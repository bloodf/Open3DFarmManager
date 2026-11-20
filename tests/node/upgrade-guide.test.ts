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
  assert.match(
    guide,
    /## 6\. Roll back[\s\S]*?restore the Connector configuration backup[\s\S]*?previous immutable application release/,
  )
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
