import { expect, test, vi } from 'vitest'
import { PasswordResetQueue } from '../../apps/farm/server/services/password-reset-queue.ts'
import { passwordResetHttp } from '../../apps/farm/server/services/password-reset-http.ts'

// Only composition is replaced. The real HTTP origin/body/rate boundary and queue run.
vi.mock('../../apps/farm/server/utils/auth/password-reset-runtime.ts', () => ({
  passwordResetRuntime: (value: unknown) => value,
}))

test('known and unknown HTTP requests finish before identity lookup and deferred delivery', async () => {
  const gate = Promise.withResolvers<void>()
  const issue = vi.fn(async (username: string) => username === 'alice')
  const deliver = vi.fn(async () => gate.promise)
  const queue = new PasswordResetQueue({ issue, consume: vi.fn() }, { deliver })
  const consumeLimit = vi.fn(async () => true)
  const runtime = {
    auth: { origin: 'https://farm.example', credentials: { consumeLimit } },
    queue,
  }
  function event(username: string) {
    return {
      req: new Request('https://farm.example/api/auth/password-reset-request', {
        method: 'POST',
        headers: {
          origin: 'https://farm.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ username, password: 'reset-request' }),
      }),
      res: { status: 200, statusText: 'OK', headers: new Headers() },
      context: { passwordReset: runtime },
    }
  }
  try {
    const known = await passwordResetHttp(event('alice'), false)
    const unknown = await passwordResetHttp(event('unknown'), false)
    expect(known).toEqual(unknown)
    expect(known).toEqual({
      message:
        'Se a conta puder receber instruções, elas serão enviadas pelo canal cadastrado.',
    })
    expect(issue).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(issue).toHaveBeenCalledWith('alice', expect.any(String))
    expect(issue).toHaveBeenCalledWith('unknown', expect.any(String))
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(consumeLimit).toHaveBeenCalledWith('a', 'reset:alice')
    expect(consumeLimit).toHaveBeenCalledWith('a', 'reset:unknown')
  } finally {
    gate.resolve()
    await queue.close()
  }
})
