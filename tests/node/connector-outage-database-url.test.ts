import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outageDatabaseUrls } from '../helpers/connector-outage-database-url.ts'

test('outage fixture and telemetry logins use their own credentials', () => {
  const urls = outageDatabaseUrls({
    port: 43210,
    fixturePassword: 'fixture:/@ secret',
    telemetryUser: 'outage_test',
    telemetryPassword: 'telemetry:/@ secret',
  })
  const fixture = new URL(urls.fixture)
  const telemetry = new URL(urls.telemetry)
  assert.equal(fixture.username, 'fixture')
  assert.equal(decodeURIComponent(fixture.password), 'fixture:/@ secret')
  assert.equal(telemetry.username, 'outage_test')
  assert.equal(decodeURIComponent(telemetry.password), 'telemetry:/@ secret')
  assert.equal(fixture.port, '43210')
  assert.equal(telemetry.port, '43210')
})
