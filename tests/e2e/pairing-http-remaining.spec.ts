import { generateKeyPairSync } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  PairingPollResponse,
  PairingStartResponse,
} from '../../packages/farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../packages/farm-protocol/src/pairing-proof.ts'

// Separate continuation, valid only together with a recorded earlier full run.
test('remaining expiry, revoked-session and exhausted-quota recovery gates', async ({
  browser,
}) => {
  test.skip(
    process.env.PAIRING_HTTP_TEST_PHASE !== 'remaining',
    'Explicit remaining-phase fixture required',
  )
  test.setTimeout(150_000)
  const origin = process.env.PAIRING_HTTP_TEST_ORIGIN
  const username = process.env.PAIRING_HTTP_TEST_USERNAME
  const password = process.env.PAIRING_HTTP_TEST_PASSWORD
  const farmId = process.env.PAIRING_HTTP_TEST_FARM_ID
  const account = process.env.PAIRING_HTTP_TEST_OWNER_ACCOUNT
  const port = process.env.PAIRING_HTTP_SYNTHETIC_TEST_PORT
  if (
    process.env.PAIRING_HTTP_TEST_DISPOSABLE !== 'yes' ||
    !origin ||
    !username ||
    !password ||
    !farmId ||
    !account ||
    !port
  )
    throw new Error('Disposable fixture configuration required')
  const url = new URL(origin)
  if (
    url.origin !== origin ||
    url.protocol !== 'https:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('Expected HTTPS loopback')
  const machine = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        origin + '/api/connector-pairing/' + path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
        },
        (res) => {
          let size = 0
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 16384) res.destroy(new Error('Response exceeded bound'))
            else chunks.push(chunk)
          })
          res.on('error', reject)
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 500,
              }),
            ),
          )
        },
      )
      req.setTimeout(10_000, () => req.destroy(new Error('Request timed out')))
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  const keypair = generateKeyPairSync('ed25519')
  const identity = new ConnectorIdentity(keypair.privateKey)
  const secrets = [
    keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keypair.privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64url'),
  ]
  const seen: string[] = []
  const reads: Promise<void>[] = []
  const begin = async () => {
    const startedResponse = await machine('start', {
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    expect(startedResponse.ok).toBe(true)
    const started = PairingStartResponse.parse(await startedResponse.json())
    secrets.push(started.device_code)
    const challengeResponse = await machine('challenge', {
      device_code: started.device_code,
    })
    expect(challengeResponse.ok).toBe(true)
    const challenge = PairingProofChallenge.parse(
      await challengeResponse.json(),
    )
    expect(
      (
        await machine('proof', {
          device_code: started.device_code,
          challenge,
          signature: identity.signPairingProof({
            challenge,
            expectedOrigin: url.origin,
            expectedAudience: 'open3dfarmmanager:pairing',
            now: Date.now(),
          }),
        })
      ).ok,
    ).toBe(true)
    return { started, challenge }
  }
  const login = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    page.on('request', (request) => {
      seen.push(request.url(), request.postData() ?? '')
      reads.push(
        request
          .allHeaders()
          .then((headers) => {
            seen.push(JSON.stringify(headers))
          })
          .catch(() => {}),
      )
    })
    page.on('response', (response) => {
      if (
        new URL(response.url()).origin === url.origin &&
        new URL(response.url()).pathname.startsWith('/api/')
      ) {
        reads.push(
          response
            .allHeaders()
            .then((headers) => {
              seen.push(JSON.stringify(headers))
            })
            .catch(() => {}),
        )
        reads.push(
          response
            .text()
            .then((body) => {
              seen.push(body)
            })
            .catch(() => {}),
        )
      }
    })
    await page.goto(origin + '/entrar')
    await page.getByLabel('Usuário').fill(username)
    await page.getByLabel('Senha').fill(password)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page).not.toHaveURL(/\/entrar$/)
    return { context, page }
  }
  const post = (
    page: Awaited<ReturnType<typeof login>>['page'],
    path: string,
    body: unknown,
  ) =>
    page.evaluate(
      async ({ path, body }) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        return response.status
      },
      { path, body },
    )
  const owner = await login()
  const approval = (userCode: string) => ({
    user_code: userCode,
    farm_id: farmId,
    expected_fingerprint: identity.fingerprint,
  })
  const expired = await begin()
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, expired.challenge.expires_at - Date.now() + 50),
    ),
  )
  expect(
    await post(
      owner.page,
      '/api/connector-pairing/approve',
      approval(expired.started.user_code),
    ),
  ).toBeGreaterThanOrEqual(400)
  const expiredResponse = await machine('claim', {
    device_code: expired.started.device_code,
  })
  expect(expiredResponse.ok).toBe(true)
  const expiredText = await expiredResponse.text()
  expect(PairingPollResponse.parse(JSON.parse(expiredText)).status).toBe(
    'pending',
  )
  expect(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(expiredText),
  ).toBe(false)
  const admin = postgres({
    host: '127.0.0.1',
    port: Number(port),
    database: 'fixture',
    username: 'fixture',
    max: 1,
    connect_timeout: 3,
  })
  try {
    const rows =
      await admin`SELECT proof_expired_at IS NOT NULL AS expired, (SELECT count(*)::int FROM farm.connector_credentials c WHERE c.agent_id=p.agent_id) AS credentials FROM farm.pairing_requests p WHERE p.agent_id=${expired.challenge.agent_id}::uuid`
    expect(rows[0]?.expired).toBe(true)
    expect(rows[0]?.credentials).toBe(0)
    const revoked = await begin()
    await admin`UPDATE farm.account_sessions SET revoked_at=${Date.now()} WHERE account_id=${account} AND revoked_at IS NULL`
    expect(
      await post(
        owner.page,
        '/api/connector-pairing/approve',
        approval(revoked.started.user_code),
      ),
    ).toBeGreaterThanOrEqual(400)
  } finally {
    await admin.end({ timeout: 3 })
    await owner.context.close()
  }
  const fresh = await login()
  try {
    const quota = await begin()
    let limited = false
    for (let attempt = 0; attempt < 61; attempt++) {
      const response = await machine('start', {})
      if (response.status === 429) {
        limited = true
        break
      }
      expect(response.status).toBe(400)
    }
    expect(limited).toBe(true)
    for (let attempt = 0; attempt < 61; attempt++)
      expect(
        (await machine('approve', {}, { origin: url.origin })).status,
      ).toBe(401)
    expect(
      await post(
        fresh.page,
        '/api/connector-pairing/approve',
        approval(quota.started.user_code),
      ),
    ).toBe(200)
    const inventory = async () =>
      fresh.page.evaluate(async (id) => {
        const response = await fetch(`/api/farms/${id}/connectors`)
        return { status: response.status, text: await response.text() }
      }, farmId)
    const matches = (text: string, status: string) => {
      const items: unknown = JSON.parse(text).connectors
      return (
        Array.isArray(items) &&
        items.some(
          (item) =>
            item.agentId === quota.challenge.agent_id &&
            item.fingerprint === identity.fingerprint &&
            item.status === status,
        )
      )
    }
    const before = await inventory()
    expect(before.status).toBe(200)
    expect(matches(before.text, 'approved')).toBe(true)
    expect(
      await post(
        fresh.page,
        `/api/farms/${farmId}/connectors/${quota.challenge.agent_id}/revoke`,
        { expected_fingerprint: identity.fingerprint },
      ),
    ).toBe(200)
    const after = await inventory()
    expect(after.status).toBe(200)
    expect(matches(after.text, 'revoked')).toBe(true)
    seen.push(
      await fresh.page.evaluate(
        () =>
          document.documentElement.outerHTML +
          JSON.stringify(localStorage) +
          JSON.stringify(sessionStorage),
      ),
    )
    await Promise.all(reads)
    const visible = seen.join('\n')
    for (const secret of secrets) expect(visible.includes(secret)).toBe(false)
    expect(/\"device_token\"\s*:/.test(visible)).toBe(false)
  } finally {
    await fresh.context.close()
  }
})
