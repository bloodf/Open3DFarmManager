import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { qualifyAnycubic } from '../../scripts/qualify/anycubic.ts'
import { qualifyPrinter } from '../../scripts/qualify/qualify.ts'

const bridgeCredentials = {
  email: 'operator@example.test',
  password: 'fake-secret',
}

test('KobraLink reports missing credentials without contacting a bridge', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected request')
  })
  const report = await qualifyPrinter({
    vendor: 'kobralink',
    host: '127.0.0.1',
  })
  assert.equal(request.mock.callCount(), 0)
  assert.deepEqual(report.identity, {})
  assert.equal(report.catalog.matchedCatalogId, null)
  assert.equal(report.qualification.status, 'unreachable')
  assert.match(report.qualification.summary, /no credential file/)
  assert.equal(report.telemetry.reason, report.qualification.summary)
})

test('KobraLink preserves safe HTTP, refused connection and timeout reasons', async (t) => {
  for (const failure of ['HTTP 404', 'ECONNREFUSED', 'timeout']) {
    await t.test(failure, async (t) => {
      t.mock.method(
        globalThis,
        'fetch',
        async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          if (failure === 'HTTP 404') return new Response(null, { status: 404 })
          if (failure === 'ECONNREFUSED')
            throw new TypeError('fetch failed', {
              cause: Object.assign(new Error('private network detail'), {
                code: 'ECONNREFUSED',
              }),
            })
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            )
          })
        },
      )
      const result = await qualifyAnycubic(
        { vendor: 'kobralink', host: '127.0.0.1', timeoutMs: 20 },
        bridgeCredentials,
      )
      assert.deepEqual(result.identity, {})
      assert.equal(result.telemetry.observed, false)
      assert.equal(result.telemetry.reason, `KobraLink: ${failure}`)
      assert.ok(!JSON.stringify(result).includes(bridgeCredentials.password))
      assert.ok(!JSON.stringify(result).includes('private network detail'))
    })
  }
})

test('KobraLink uses returned identity labels without the status API synthetic model', async (t) => {
  for (const model of ['Returned printer model', undefined]) {
    await t.test(String(model), async (t) => {
      t.mock.method(
        globalThis,
        'fetch',
        async (input: Parameters<typeof fetch>[0]) => {
          const path = new URL(String(input)).pathname
          if (path.includes('/auth/'))
            return new Response(null, {
              headers: {
                'set-cookie':
                  'better-auth.session_token=fake; Path=/; HttpOnly',
              },
            })
          const printer = {
            id: 'fake',
            deviceId: 'returned-serial',
            name: 'Fake',
            model,
            live: {
              firmwareVersion: 'returned-firmware',
              connected: true,
              updatedAt: Date.now(),
              printState: 'standby',
            },
          }
          return Response.json(
            path === '/api/v1/printers' ? [printer] : printer,
          )
        },
      )
      const result = await qualifyAnycubic(
        { vendor: 'kobralink', host: '127.0.0.1' },
        bridgeCredentials,
      )
      assert.equal(result.identity.model, model ?? null)
      assert.equal(result.identity.vendor, undefined)
      assert.equal(result.identity.serial, 'returned-serial')
      assert.equal(result.identity.firmware, 'returned-firmware')
      assert.equal(result.telemetry.observed, true)
    })
  }
})

test('Anycubic qualification dispatcher defaults to the LAN connector port 9883', async () => {
  // An empty host is rejected before transport creation; no network request is possible.
  const report = await qualifyPrinter({
    vendor: 'anycubic',
    host: '',
    timeoutMs: 1,
  })
  assert.equal(report.port, 9883)
})

test('Anycubic defaults to 9883 and authenticates with LAN credentials', async () => {
  const credentials = {
    username: 'lan-user',
    password: 'synthetic-lan-password',
  }
  const sim = await startAnycubicSimulator({
    port: 0,
    initialState: 'RUNNING',
    credentials,
  })
  const trust = {
    caPem: sim.syntheticTrust,
    pinSha256: createHash('sha256')
      .update(new X509Certificate(sim.syntheticTrust).raw)
      .digest('hex'),
  }
  try {
    const options = {
      vendor: 'anycubic',
      host: sim.host,
      port: sim.port,
      timeoutMs: 1000,
    }
    const rejected = await qualifyAnycubic(options, {
      ...credentials,
      ...trust,
      password: 'wrong',
    })
    assert.equal(rejected.telemetry.observed, false)
    const accepted = await qualifyAnycubic(options, {
      ...credentials,
      ...trust,
    })
    assert.equal(accepted.telemetry.observed, true)
    assert.ok(accepted.telemetry.fields.includes('progress'))
  } finally {
    await sim.close()
  }
})
