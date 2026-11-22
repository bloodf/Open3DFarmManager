// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/web_api/#job-queue-apis
import { describe, expect, it } from 'vitest'
import {
  awaitsCollection,
  confirmCollection,
  observeCompletedAttempt,
  observeDispatch,
  observeFinishedRun,
} from '../../packages/connector/src/control/queue-collection.ts'

describe('collection attempt state', () => {
  it('retains the hold across duplicate observations and serialization', () => {
    const first = observeCompletedAttempt({ attempts: [] }, 'run-1')
    const restarted = JSON.parse(JSON.stringify(first))
    expect(awaitsCollection(observeCompletedAttempt(restarted, 'run-1'))).toBe(
      true,
    )
    const collected = confirmCollection(restarted, 'run-1')
    expect(awaitsCollection(observeCompletedAttempt(collected, 'run-1'))).toBe(
      false,
    )
  })
  it('requires confirmation of each attempt', () => {
    const state = observeCompletedAttempt(
      observeCompletedAttempt({ attempts: [] }, 'run-1'),
      'run-2',
    )
    expect(awaitsCollection(confirmCollection(state, 'run-1'))).toBe(true)
    expect(() => confirmCollection(state, 'unknown')).toThrow()
  })
})

it('retains the first dispatch when a second is observed before its finish', () => {
  const state = observeDispatch(observeDispatch({ attempts: [] }, 100), 200)
  expect(observeFinishedRun(state, 150).attempts).toEqual([
    { id: '150', status: 'awaiting-collection' },
  ])
})
