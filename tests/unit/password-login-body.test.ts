import { describe, expect, test } from 'vitest'
import { readLoginBody } from '../../apps/farm/server/services/authenticated-session.ts'
const request = (
  body: string | Uint8Array,
  headers: Record<string, string> = {},
) =>
  new Request('https://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  })
describe('real Request login body boundary', () => {
  test('times out complete JSON when its stream never ends', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          Buffer.from('{"username":"fixture_user","password":"pass"}'),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    }
    await expect(
      readLoginBody(new Request('https://localhost/api/auth/login', init)),
    ).rejects.toMatchObject({ status: 408 })
    expect(cancelled).toBe(true)
  }, 7000)
  test('accepts only independent username and password', async () => {
    expect(
      await readLoginBody(
        request('{"username":"fixture_user","password":"pass"}'),
      ),
    ).toEqual({ username: 'fixture_user', password: 'pass' })
  })
  for (const body of [
    '{"username":"fixture_user","username":"other","password":"pass"}',
    '{"username":"fixture_user","password":"pass","accountId":"chosen"}',
    '{"username":"someone@example.invalid","password":"pass"}',
    '{"username":"fixture_user","password":"\\ud800"}',
    '{"username":"fixture_user","password":{"nested":"pass"}}',
  ])
    test('rejects ambiguous or invalid credentials: ' + body, async () => {
      await expect(readLoginBody(request(body))).rejects.toMatchObject({
        status: 400,
      })
    })
  test('rejects invalid UTF8 instead of replacing bytes', async () => {
    const prefix = Buffer.from('{"username":"fixture_user","password":"')
    await expect(
      readLoginBody(
        request(
          Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}')]),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 })
  })
  test('bounds bytes before JSON parsing', async () => {
    await expect(
      readLoginBody(request('a'.repeat(4097))),
    ).rejects.toMatchObject({ status: 413 })
  })
  test('rejects compression and form submissions', async () => {
    await expect(
      readLoginBody(request('{}', { 'content-encoding': 'gzip' })),
    ).rejects.toMatchObject({ status: 415 })
    await expect(
      readLoginBody(
        request('{}', { 'content-type': 'application/x-www-form-urlencoded' }),
      ),
    ).rejects.toMatchObject({ status: 415 })
  })
})
