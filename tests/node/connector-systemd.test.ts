import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const unit = readFileSync(new URL('../../infra/systemd/open3dfarm-connector.service', import.meta.url), 'utf8')

test('service runs the connector with private persistent state and hardening', () => {
  assert.match(unit, /^User=openfarm-connector$/m)
  assert.match(unit, /^Group=openfarm-connector$/m)
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/openfarm-connector\/dist\/cli\.js run --config \/var\/lib\/openfarm-connector\/runtime\.json --credential-file \/var\/lib\/openfarm-connector\/credential\.json --data-dir \/var\/lib\/openfarm-connector$/m)
  for (const setting of ['ProtectSystem=strict', 'NoNewPrivileges=true', 'Restart=on-failure', 'ReadWritePaths=/var/lib/openfarm-connector']) {
    assert.ok(unit.split('\n').includes(setting), setting)
  }
})
