import { describe, expect, it } from 'vitest'
import { createKobraLinkClient } from '../../packages/connector/src/kobralink/client.ts'
const input = {
  ownership: 'fresh_owned',
  mode: 'signin',
  name: 'test',
  email: 'test@example.invalid',
  password: 'synthetic-password',
} as const
const token = 'better-auth.session_token=synthetic'
function fixture(cookies: string[], secure = false) {
  const origin = `${secure ? 'https' : 'http'}://127.0.0.1:7100`
  const sent: string[] = []
  const client = createKobraLinkClient({
    origin,
    allowedOrigins: [origin],
    fetch: async (url, init) => {
      if (url.includes('/api/auth/')) {
        const headers = new Headers()
        cookies.forEach((value) => headers.append('set-cookie', value))
        return new Response('{}', { headers })
      }
      sent.push(new Headers(init.headers).get('cookie') ?? '')
      return new Response('[]', {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { client, sent }
}
describe('revocable session custody', () => {
  it('sends only the session token on every reused request', async () => {
    const { client, sent } = fixture([
      token,
      'better-auth.session_data=cached',
      'unknown=secret',
    ])
    await client.authenticate(input)
    await client.listPrinters()
    await client.listPrinters()
    expect(sent).toEqual([token, token])
  })
  it.each([
    [],
    [token, token],
    ['better-auth.session_token='],
    [token + '; Secure'],
    [token + '; Domain=127.0.0.1'],
    [token + '; Path=/other'],
    ['__Secure-' + token + '; Secure'],
    [token, '__Secure-' + token + '; Secure'],
  ])('rejects invalid HTTP cookie set %j', async (...args) => {
    const { client } = fixture(args)
    await expect(client.authenticate(input)).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(client.listPrinters()).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })
  it('requires the secure prefix on HTTPS', async () => {
    await expect(
      fixture([token], true).client.authenticate(input),
    ).rejects.toMatchObject({ code: 'invalid' })
    const { client, sent } = fixture(['__Secure-' + token + '; Secure'], true)
    await client.authenticate(input)
    await client.listPrinters()
    expect(sent).toEqual(['__Secure-' + token])
  })
  it('cannot restore a cleared session from a pending authentication', async () => {
    let resolve: (response: Response) => void = () => {}
    const origin = 'http://127.0.0.1:7100'
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      fetch: () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    })
    const pending = client.authenticate(input)
    client.clearSession()
    resolve(new Response('{}', { headers: { 'set-cookie': token } }))
    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(client.listPrinters()).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })
  it('does not restore an old login after a newer failed login', async () => {
    const pendingResponses: Array<(response: Response) => void> = []
    const origin = 'http://127.0.0.1:7100'
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      fetch: () =>
        new Promise<Response>((resolve) => pendingResponses.push(resolve)),
    })
    const old = client.authenticate(input)
    const newer = client.authenticate(input)
    pendingResponses[1]?.(new Response('{}', { status: 401 }))
    await expect(newer).rejects.toMatchObject({ code: 'unauthorized' })
    pendingResponses[0]?.(
      new Response('{}', { headers: { 'set-cookie': token } }),
    )
    await expect(old).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(client.listPrinters()).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })
})
