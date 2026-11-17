import { createError } from 'nuxt/server'
import { MIN_PASSWORD_CHARS, passwordTooShort } from './account-registration.ts'

export interface PasswordChangeInput {
  currentPassword: string
  newPassword: string
}

const invalid = () =>
  createError({ status: 400, message: 'Dados de senha inválidos.' })
/** Same status and shape as registration's refusal for a short password. */
export const passwordTooShortError = () =>
  createError({
    status: 400,
    message: `Use uma nova senha com ${MIN_PASSWORD_CHARS} caracteres ou mais.`,
  })

/** Validates the parsed JSON body of POST /api/auth/password. */
export function parsePasswordChange(input: unknown): PasswordChangeInput {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    !('currentPassword' in input) ||
    !('newPassword' in input) ||
    typeof input.currentPassword !== 'string' ||
    typeof input.newPassword !== 'string' ||
    input.currentPassword.length < 1 ||
    input.newPassword.length < 1 ||
    input.currentPassword.includes('\0') ||
    input.newPassword.includes('\0') ||
    Buffer.byteLength(input.currentPassword) > 1024 ||
    Buffer.byteLength(input.newPassword) > 1024
  )
    throw invalid()
  if (passwordTooShort(input.newPassword)) throw passwordTooShortError()
  return {
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
  }
}
