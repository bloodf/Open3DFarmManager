import { expect, test, vi } from 'vitest'
import { PasswordResetQueue } from '../../apps/farm/server/services/password-reset-queue.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('admission precedes lookup; total jobs and concurrent deliveries are bounded', async () => {
  const gate = Promise.withResolvers<void>()
  const issue = vi.fn(async () => true)
  const deliver = vi.fn(async () => gate.promise)
  const queue = new PasswordResetQueue({ issue, consume: vi.fn() }, { deliver })
  try {
    for (let i = 0; i < 64; i++) expect(queue.enqueue('alice')).toBe(true)
    expect(queue.enqueue('alice')).toBe(false)
    expect(issue).not.toHaveBeenCalled()
    await turn()
    expect(issue).toHaveBeenCalledTimes(2)
    expect(deliver).toHaveBeenCalledTimes(2)
    const closing = queue.close()
    expect(queue.enqueue('unknown')).toBe(false)
    gate.resolve()
    await closing
    await turn()
    expect(issue).toHaveBeenCalledTimes(2)
  } finally {
    gate.resolve()
    await queue.close()
  }
})

test('shutdown cancels scheduled jobs and never begins delivery after an in-flight lookup', async () => {
  const gate = Promise.withResolvers<boolean>()
  const deliver = vi.fn(async () => {})
  const queue = new PasswordResetQueue(
    { issue: () => gate.promise, consume: vi.fn() },
    { deliver },
  )
  queue.enqueue('alice')
  await turn()
  const closing = queue.close()
  gate.resolve(true)
  await closing
  expect(deliver).not.toHaveBeenCalled()
  const issue = vi.fn(async () => true)
  const scheduled = new PasswordResetQueue(
    { issue, consume: vi.fn() },
    { deliver },
  )
  scheduled.enqueue('alice')
  await scheduled.close()
  await turn()
  expect(issue).not.toHaveBeenCalled()
})

test('delivery and lookup errors are contained without exposing payloads or blocking later jobs', async () => {
  const issue = vi.fn(async (username: string) => {
    if (username === 'lookup_failure') throw new Error('private storage detail')
    return true
  })
  const queue = new PasswordResetQueue(
    { issue, consume: vi.fn() },
    {
      deliver: async () => {
        throw new Error('private delivery detail')
      },
    },
  )
  try {
    queue.enqueue('lookup_failure')
    queue.enqueue('alice')
    queue.enqueue('later')
    await turn()
    await turn()
    expect(issue).toHaveBeenCalledTimes(3)
    expect(queue.failureCount).toBe(3)
  } finally {
    await queue.close()
  }
})

test('shutdown signals active adapters and drains them before resolving', async () => {
  const started = Promise.withResolvers<void>()
  const stopped = vi.fn()
  const queue = new PasswordResetQueue(
    { issue: async () => true, consume: vi.fn() },
    {
      deliver: async (_username, _token, signal) => {
        started.resolve()
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              stopped()
              resolve()
            },
            { once: true },
          ),
        )
      },
    },
  )
  queue.enqueue('alice')
  await started.promise
  await queue.close()
  expect(stopped).toHaveBeenCalledTimes(1)
  expect(queue.enqueue('alice')).toBe(false)
})
