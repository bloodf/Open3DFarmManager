import { describe, expect, it } from 'vitest'
import {
  validateMoonrakerTargetInput,
  withoutMoonrakerKey,
} from '../../apps/farm/app/utils/moonraker-onboarding.ts'

describe('Moonraker login onboarding', () => {
  it('accepts a login and removes secrets from the displayed target', () => {
    const result = validateMoonrakerTargetInput({
      origin: 'http://localhost:7125',
      username: 'person',
      password: 'secret',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('invalid target')
    expect(JSON.stringify(withoutMoonrakerKey(result.target))).not.toMatch(
      /person|secret/,
    )
  })
  it('rejects mixed and incomplete credentials', () => {
    expect(
      validateMoonrakerTargetInput({
        origin: 'http://localhost:7125',
        apiKey: 'key',
        username: 'person',
        password: 'secret',
      }).ok,
    ).toBe(false)
    expect(
      validateMoonrakerTargetInput({
        origin: 'http://localhost:7125',
        username: 'person',
      }).ok,
    ).toBe(false)
  })
})
