import { describe, expect, it } from 'vitest'
import { createLatestRequestGuard } from '../../apps/farm/app/components/ui-misc-guards.ts'

describe('latest request guard', () => {
  it('only accepts the most recently issued request', () => {
    const guard = createLatestRequestGuard()
    const oldRequest = guard.next()
    const currentRequest = guard.next()

    expect(guard.isCurrent(oldRequest)).toBe(false)
    expect(guard.isCurrent(currentRequest)).toBe(true)
  })

  it('invalidates in-flight requests when the scope changes', () => {
    const guard = createLatestRequestGuard()
    const request = guard.next()

    guard.invalidate()

    expect(guard.isCurrent(request)).toBe(false)
  })
})
