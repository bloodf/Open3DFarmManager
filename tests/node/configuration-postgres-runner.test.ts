import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptanceOptions } from '../helpers/configuration-postgres/options.ts'

const valid = {
  CONFIGURATION_POSTGRES_ADMITTED: 'yes',
  CONFIGURATION_POSTGRES_CONTEXT: 'colima-openfarm-fixture',
  CONFIGURATION_POSTGRES_IMAGE: 'postgres:17@sha256:' + 'a'.repeat(64),
  CONFIGURATION_POSTGRES_EVIDENCE: '/private/evidence',
  CONFIGURATION_POSTGRES_PORT: '15432',
}
test('requires admission, owned context, pinned image and external evidence before Docker access', () => {
  assert.equal(acceptanceOptions(valid, '/repo').port, 15432)
  for (const patch of [
    { CONFIGURATION_POSTGRES_ADMITTED: '' },
    { CONFIGURATION_POSTGRES_CONTEXT: 'orbstack' },
    { CONFIGURATION_POSTGRES_IMAGE: 'postgres:17' },
    { CONFIGURATION_POSTGRES_EVIDENCE: '/repo/evidence' },
    { CONFIGURATION_POSTGRES_PORT: '0' },
  ])
    assert.throws(() => acceptanceOptions({ ...valid, ...patch }, '/repo'))
})
