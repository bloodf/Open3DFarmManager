import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registrationAdmission } from '../helpers/kobralink-rtc/admission.ts'

const env = {
  KOBRALINK_RTC_ADMITTED: 'yes',
  KOBRALINK_RTC_CONTEXT: 'colima-openfarm-kobralink-togiej',
  KOBRALINK_RTC_EVIDENCE: '/private/evidence',
  KOBRALINK_RTC_POSTGRES_IMAGE: 'postgres:17@sha256:' + 'a'.repeat(64),
  KOBRALINK_RTC_KOBRA_IMAGE: 'kobralink@sha256:' + 'b'.repeat(64),
  KOBRALINK_RTC_UPSTREAM_REVISION: '5a5e5d9',
  KOBRALINK_RTC_DB_PORT: '15432',
  KOBRALINK_RTC_HTTPS_PORT: '18443',
  KOBRALINK_RTC_KOBRA_PORT: '17100',
  KOBRALINK_RTC_MQTT_PORT: '18883',
}

test('accepts an explicit isolated registration admission', () => {
  assert.deepEqual(
    registrationAdmission(env, '/checkout').ports,
    [15432, 18443, 17100, 18883],
  )
})

for (const [key, value] of Object.entries({
  KOBRALINK_RTC_ADMITTED: '',
  KOBRALINK_RTC_CONTEXT: 'orbstack',
  KOBRALINK_RTC_EVIDENCE: '/checkout/evidence',
  KOBRALINK_RTC_POSTGRES_IMAGE: 'postgres:17',
  KOBRALINK_RTC_KOBRA_IMAGE: 'kobralink:latest',
  KOBRALINK_RTC_UPSTREAM_REVISION: 'main',
  KOBRALINK_RTC_DB_PORT: '5432.5',
  KOBRALINK_RTC_HTTPS_PORT: '15432',
  KOBRALINK_RTC_KOBRA_PORT: '80',
  KOBRALINK_RTC_MQTT_PORT: '65536',
})) {
  test(`rejects unsafe ${key} before resource creation`, () => {
    assert.throws(() =>
      registrationAdmission({ ...env, [key]: value }, '/checkout'),
    )
  })
}

test('rejects evidence in a sibling whose name merely starts with dots', () => {
  assert.throws(() =>
    registrationAdmission(
      { ...env, KOBRALINK_RTC_EVIDENCE: '/checkout/..evidence' },
      '/checkout',
    ),
  )
})
