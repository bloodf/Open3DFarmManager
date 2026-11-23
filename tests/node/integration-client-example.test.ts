import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import {
  ApiError,
  IntegrationClient,
  verifyWebhook,
} from '../../examples/integration-client/client.ts'

test('reference client authenticates, paginates and submits idempotent requests', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/oauth/token'))
      return Response.json({ access_token: 'test-token' })
    if (url.endsWith('/printers?cursor=next'))
      return Response.json({ data: [{ id: 'p2' }], nextCursor: null })
    if (url.endsWith('/printers'))
      return Response.json({ data: [{ id: 'p1' }], nextCursor: 'next' })
    if (url.endsWith('/printers/p1/status'))
      return Response.json({ state: 'idle' })
    if (url.endsWith('/inventory'))
      return Response.json({ data: [], nextCursor: null })
    if (url.endsWith('/printers/p1/actions'))
      return Response.json({ id: 'a1', status: 'queued' })
    return Response.json(
      { code: 'not-found' },
      { status: 404, headers: { 'content-type': 'application/problem+json' } },
    )
  }
  const client = new IntegrationClient(
    'https://sandbox.example',
    'client',
    'secret',
    fetcher,
  )
  await client.authenticate()
  assert.deepEqual(
    (await client.listPrinters()).map(({ id }) => id),
    ['p1', 'p2'],
  )
  assert.deepEqual(await client.printerStatus('p1'), { state: 'idle' })
  assert.deepEqual(await client.inventory(), [])
  await client.submitAction('p1', 'pause', {}, 'stable-key')
  const action = calls.at(-1)!
  assert.equal(
    new URL(action.url).pathname,
    '/api/integrations/v1/printers/p1/actions',
  )
  assert.equal(
    new Headers(action.init?.headers).get('Idempotency-Key'),
    'stable-key',
  )
  assert.equal(
    new Headers(action.init?.headers).get('authorization'),
    'Bearer test-token',
  )
  assert.equal(
    new URLSearchParams(String(calls[0]?.init?.body)).get('grant_type'),
    'client_credentials',
  )
})

test('reference client exposes stable API problem codes', async () => {
  let count = 0
  const guarded = new IntegrationClient(
    'https://sandbox.example',
    'c',
    's',
    async () => {
      if (++count === 1) return Response.json({ access_token: 'token' })
      return Response.json(
        { code: 'insufficient-scope', detail: 'Grant required' },
        { status: 403 },
      )
    },
  )
  await guarded.authenticate()
  await assert.rejects(
    guarded.listPrinters(),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 403 &&
      error.code === 'insufficient-scope',
  )
})

test('webhook verifier signs timestamp plus exact raw bytes and supports rotation', () => {
  const body = Buffer.from('{"type":"webhook.test"}')
  const timestamp = String(Date.now())
  const secret = 'sandbox-signing-secret'
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex')
  assert.equal(
    verifyWebhook(
      body,
      timestamp,
      `v1=${'0'.repeat(64)}, v1=${signature}`,
      secret,
    ),
    true,
  )
  assert.equal(
    verifyWebhook(
      Buffer.from(`${body} `),
      timestamp,
      `v1=${signature}`,
      secret,
    ),
    false,
  )
  assert.equal(verifyWebhook(body, 'bad', `v1=${signature}`, secret), false)
})

test(
  'sandbox smoke test: authenticate, read printers and inventory, inspect printer state',
  {
    skip:
      process.env.OPENFARM_INTEGRATION_E2E !== '1'
        ? 'set OPENFARM_INTEGRATION_E2E=1 to opt in'
        : false,
  },
  async () => {
    const required = [
      'OPENFARM_SANDBOX_URL',
      'OPENFARM_CLIENT_ID',
      'OPENFARM_CLIENT_SECRET',
      'OPENFARM_PRINTER_ID',
    ] as const
    for (const name of required)
      assert.ok(process.env[name], `${name} is required for the sandbox test`)
    const client = new IntegrationClient(
      process.env.OPENFARM_SANDBOX_URL!,
      process.env.OPENFARM_CLIENT_ID!,
      process.env.OPENFARM_CLIENT_SECRET!,
    )
    await client.authenticate()
    const printers = await client.listPrinters()
    assert.ok(
      printers.some(
        (printer) => printer.id === process.env.OPENFARM_PRINTER_ID,
      ),
    )
    const status = await client.printerStatus(process.env.OPENFARM_PRINTER_ID!)
    assert.ok(typeof status.state === 'string')
    assert.ok(Array.isArray(await client.inventory()))
  },
)
