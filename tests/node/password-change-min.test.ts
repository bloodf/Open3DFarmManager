// POST /api/auth/password applies the registration/reset minimum (MIN_PASSWORD_CHARS)
// to the new password, refusing short ones with registration's 400 error shape.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createError } from 'nuxt/server'
import { MIN_PASSWORD_CHARS } from '../../apps/farm/server/services/account-registration.ts'
import { parsePasswordChange } from '../../apps/farm/server/services/password-change.ts'

const currentPassword = 'current-password-value'

function caught(run: () => unknown): Error & Record<string, unknown> {
  try {
    run()
  } catch (error) {
    return error as Error & Record<string, unknown>
  }
  assert.fail('expected the password change to be refused')
}

test('the minimum is the shared registration constant', () => {
  assert.equal(MIN_PASSWORD_CHARS, 12)
})

test('an 11 character new password is refused like registration', () => {
  const error = caught(() =>
    parsePasswordChange({ currentPassword, newPassword: 'a'.repeat(11) }),
  )
  // Registration refuses short passwords with createError({ status: 400, message }).
  const registration = createError({
    status: 400,
    message: 'Não foi possível criar a conta.',
  }) as unknown as Error & Record<string, unknown>
  assert.equal(error.constructor, registration.constructor)
  assert.equal(error.status, 400)
  assert.equal(error.statusCode, registration.statusCode)
  assert.deepEqual(
    Object.keys(JSON.parse(JSON.stringify(error))).sort(),
    Object.keys(JSON.parse(JSON.stringify(registration))).sort(),
  )
  assert.match(error.message, /12 caracteres ou mais/)
})

test('code points are counted, not UTF-16 units', () => {
  const error = caught(() =>
    parsePasswordChange({ currentPassword, newPassword: '😀'.repeat(11) }),
  )
  assert.equal(error.status, 400)
})

test('a 12 character new password is accepted', () => {
  assert.deepEqual(
    parsePasswordChange({ currentPassword, newPassword: 'a'.repeat(12) }),
    { currentPassword, newPassword: 'a'.repeat(12) },
  )
})

test('malformed bodies keep the generic invalid-data refusal', () => {
  const error = caught(() =>
    parsePasswordChange({ newPassword: 'a'.repeat(12) }),
  )
  assert.equal(error.status, 400)
  assert.equal(error.message, 'Dados de senha inválidos.')
})
