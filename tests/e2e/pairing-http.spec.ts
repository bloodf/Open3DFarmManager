import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import postgres from 'postgres'
import { verifyConnectorCredential } from '../../apps/farm/server/utils/connector-credentials.ts'
import { expect, test } from '@playwright/test'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  PairingStartResponse,
  PairingPollResponse,
} from '../../packages/farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../packages/farm-protocol/src/pairing-proof.ts'

// This acceptance test requires an independently prepared disposable HTTPS/PG fixture.
// It deliberately does not start a server, create a database, or substitute HTTP routes.
const origin = process.env.PAIRING_HTTP_TEST_ORIGIN
const username = process.env.PAIRING_HTTP_TEST_USERNAME
const password = process.env.PAIRING_HTTP_TEST_PASSWORD
const farmId = process.env.PAIRING_HTTP_TEST_FARM_ID
const otherFarmId = process.env.PAIRING_HTTP_TEST_OTHER_FARM_ID
const publicKeyFile = process.env.PAIRING_HTTP_TEST_PUBLIC_KEY_FILE
const keyId = process.env.PAIRING_HTTP_TEST_KEY_ID
const adminUsername = process.env.PAIRING_HTTP_TEST_ADMIN_USERNAME
const operatorUsername = process.env.PAIRING_HTTP_TEST_OPERATOR_USERNAME
const adminAccount = process.env.PAIRING_HTTP_TEST_ADMIN_ACCOUNT
const ownerAccount = process.env.PAIRING_HTTP_TEST_OWNER_ACCOUNT
const databasePort = process.env.PAIRING_HTTP_SYNTHETIC_TEST_PORT
const dropControl = process.env.PAIRING_HTTP_TEST_DROP_CONTROL
const expiredCookie = process.env.PAIRING_HTTP_TEST_EXPIRED_COOKIE
const enabled = process.env.PAIRING_HTTP_TEST_DISPOSABLE === 'yes'

test('real HTTPS pairing, lost claim recovery and fresh pairing', async ({
  page,
}) => {
  test.skip(!enabled, 'Requires explicit disposable pairing HTTP fixture')
  test.setTimeout(150_000)
  if (
    !origin ||
    !username ||
    !password ||
    !farmId ||
    !otherFarmId ||
    !publicKeyFile ||
    !keyId ||
    !databasePort ||
    !dropControl ||
    !expiredCookie ||
    !adminUsername ||
    !operatorUsername ||
    !adminAccount ||
    !ownerAccount
  )
    throw new Error('Missing disposable pairing HTTP fixture configuration')
  const url = new URL(origin)
  if (
    url.origin !== origin ||
    url.protocol !== 'https:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Fixture origin must be canonical HTTPS loopback')

  const machine = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const request = httpsRequest(
        origin + '/api/connector-pairing/' + path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 16384)
              response.destroy(new Error('Fixture response exceeded bound'))
            else chunks.push(chunk)
          })
          response.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
              }),
            ),
          )
          response.on('error', reject)
        },
      )
      request.setTimeout(10_000, () =>
        request.destroy(new Error('Fixture request timed out')),
      )
      request.on('error', reject)
      request.end(payload)
    })
  const pair = generateKeyPairSync('ed25519')
  const privatePem = pair.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString()
  const identity = new ConnectorIdentity(pair.privateKey)
  const browserBytes: string[] = []
  const responseReads: Promise<void>[] = []
  const trackPage = (tracked: typeof page) => {
    tracked.on('request', (request) => {
      browserBytes.push(request.url(), request.postData() ?? '')
      responseReads.push(
        request
          .allHeaders()
          .then((headers) => {
            browserBytes.push(JSON.stringify(headers))
          })
          .catch(() => {}),
      )
    })
    tracked.on('response', (response) => {
      if (
        new URL(response.url()).origin === url.origin &&
        new URL(response.url()).pathname.startsWith('/api/')
      )
        responseReads.push(
          response
            .allHeaders()
            .then((headers) => {
              browserBytes.push(JSON.stringify(headers))
            })
            .catch(() => {}),
        )
      if (
        new URL(response.url()).origin === url.origin &&
        new URL(response.url()).pathname.startsWith('/api/')
      )
        responseReads.push(
          response
            .text()
            .then((body) => {
              browserBytes.push(body)
            })
            .catch(() => {}),
        )
    })
  }
  trackPage(page)
  const connectorSecrets = [
    privatePem,
    pair.privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64url'),
  ]

  const request = {
    public_key_spki: identity.publicKeySpki,
    platform: 'linux',
    version: '0.0.1',
  }
  for (const headers of [
    { origin },
    { cookie: 'test=value' },
    { 'sec-fetch-site': 'same-origin' },
  ]) {
    expect((await machine('start', request, headers)).ok).toBe(false)
  }
  expect((await machine('start', { ...request, extra: true })).ok).toBe(false)
  expect(
    (await machine('start', request, { 'content-type': 'text/plain' })).ok,
  ).toBe(false)

  const nativeFetch = await fetch(origin + '/api/connector-pairing/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  expect(nativeFetch.ok).toBe(true)
  PairingStartResponse.parse(await nativeFetch.json())

  expect(
    (await machine('start', { ...request, padding: 'x'.repeat(4097) })).status,
  ).toBe(413)

  let replayChecked = false
  async function begin() {
    const response = await machine('start', request)
    expect(response.ok).toBe(true)
    const started = PairingStartResponse.parse(await response.json())
    connectorSecrets.push(started.device_code)
    expect(started.fingerprint).toBe(identity.fingerprint)
    const challengeResponse = await machine('challenge', {
      device_code: started.device_code,
    })
    expect(challengeResponse.ok).toBe(true)
    const challenge = PairingProofChallenge.parse(
      await challengeResponse.json(),
    )
    const proof = {
      device_code: started.device_code,
      challenge,
      signature: identity.signPairingProof({
        challenge,
        expectedOrigin: url.origin,
        expectedAudience: 'open3dfarmmanager:pairing',
        now: Date.now(),
      }),
    }
    expect((await machine('proof', proof)).ok).toBe(true)
    if (!replayChecked) {
      expect((await machine('proof', proof)).ok).toBe(false)
      replayChecked = true
    }
    return { started, challenge }
  }
  expect((await machine('start?unexpected=1', request)).status).toBe(400)
  expect((await machine('challenge', {})).status).toBeGreaterThanOrEqual(400)
  expect((await machine('claim', {})).status).toBeGreaterThanOrEqual(400)
  expect(
    (await machine('approve', {}, { origin: 'https://invalid.example' }))
      .status,
  ).toBe(403)
  expect((await machine('approve', {}, { origin: url.origin })).status).toBe(
    401,
  )
  const first = await begin()
  await page.goto(origin + '/entrar')
  await page.getByLabel('Usuário').fill(username)
  await page.getByLabel('Senha').fill(password)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page).not.toHaveURL(/\/entrar$/)
  const browserPost = (path: string, body: unknown) =>
    page.evaluate(
      async ({ path, body }) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { status: response.status, text: await response.text() }
      },
      { path, body },
    )
  const approval = {
    user_code: first.started.user_code,
    farm_id: farmId,
    expected_fingerprint: identity.fingerprint,
  }
  expect(
    (
      await browserPost('/api/connector-pairing/approve', {
        ...approval,
        farm_id: otherFarmId,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400)
  expect(
    (
      await browserPost('/api/connector-pairing/approve', {
        ...approval,
        expected_fingerprint: 'SHA256:' + 'A'.repeat(43),
      })
    ).status,
  ).toBeGreaterThanOrEqual(400)
  await page.goto(origin + '/parear')
  await page.getByLabel('Farm de destino').selectOption(farmId)
  await page
    .getByLabel('Código exibido no Connector')
    .fill(first.started.user_code)
  await page
    .getByLabel('Impressão digital exibida no Connector')
    .fill(identity.fingerprint)
  await page
    .getByLabel('Conferi a impressão digital completa e a farm de destino.')
    .check()
  const approvalResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/connector-pairing/approve' &&
      response.request().method() === 'POST',
  )
  await page
    .getByRole('button', { name: 'Aprovar Connector', exact: true })
    .click()
  const approved = await approvalResponse
  expect(approved.status()).toBe(200)
  const approvedText = await approved.text()
  expect(approvedText.includes(first.started.device_code)).toBe(false)
  expect(
    (await browserPost('/api/connector-pairing/approve', approval)).status,
  ).toBeGreaterThanOrEqual(400)
  const claims = await Promise.all([
    machine('claim', { device_code: first.started.device_code }),
    machine('claim', { device_code: first.started.device_code }),
  ])
  const successful = claims.filter((response) => response.ok)
  expect(successful).toHaveLength(1)
  const claimed = PairingPollResponse.parse(await successful[0]!.json())
  if (claimed.status !== 'approved')
    throw new Error('Expected one approved claim')
  connectorSecrets.push(claimed.device_token)
  expect(claimed.agent_id).toBe(first.challenge.agent_id)
  expect(claimed.farm_id).toBe(farmId)
  const publicKey = createPublicKey(await readFile(publicKeyFile))
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const verifyKey = await crypto.subtle.importKey(
    'spki',
    spki,
    'Ed25519',
    false,
    ['verify'],
  )
  const verified = await verifyConnectorCredential({
    token: claimed.device_token,
    issuer: url.origin,
    audience: 'open3dfarmmanager:pairing',
    publicKeys: new Map([[keyId, verifyKey]]),
    ttlSeconds: 300,
    nowSeconds: Math.floor(Date.now() / 1000),
    agentId: first.challenge.agent_id,
    farmId,
    publicKeySpki: identity.publicKeySpki,
  })
  expect(verified.fingerprint).toBe(identity.fingerprint)
  expect(approvedText.includes(claimed.device_token)).toBe(false)
  // Simulate loss after committed delivery: the browser discovers the exact identity in inventory.
  const inventory = await page.evaluate(
    async (id) => (await fetch(`/api/farms/${id}/connectors`)).text(),
    farmId,
  )
  expect(inventory).toContain(first.challenge.agent_id)
  expect(inventory).toContain(identity.fingerprint)
  expect(inventory.includes(first.started.device_code)).toBe(false)
  expect(inventory.includes(claimed.device_token)).toBe(false)
  const revokePath = `/api/farms/${farmId}/connectors/${first.challenge.agent_id}/revoke`
  expect(
    (
      await browserPost(revokePath, {
        expected_fingerprint: 'SHA256:' + 'A'.repeat(43),
      })
    ).status,
  ).toBeGreaterThanOrEqual(400)
  await page.goto(origin + '/connectors')
  await page.getByLabel('Selecione uma farm').selectOption(farmId)
  const row = page.locator('li').filter({ hasText: first.challenge.agent_id })
  await expect(row).toContainText(identity.fingerprint)
  await row.getByRole('button', { name: 'Revogar este Connector' }).click()
  const recovery = page.getByRole('region', { name: 'Recuperação e revogação' })
  await expect(recovery).toContainText(farmId)
  await expect(recovery).toContainText(first.challenge.agent_id)
  await expect(recovery).toContainText(identity.fingerprint)
  await recovery
    .getByLabel('Conferi este Connector e quero revogar seu registro.')
    .check()
  const revoked = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === revokePath &&
      response.request().method() === 'POST',
  )
  await recovery.getByRole('button', { name: 'Confirmar revogação' }).click()
  expect((await revoked).status()).toBe(200)
  const second = await begin()
  expect(second.challenge.agent_id).not.toBe(first.challenge.agent_id)
  expect(
    (
      await browserPost('/api/connector-pairing/approve', {
        ...approval,
        user_code: second.started.user_code,
      })
    ).status,
  ).toBe(200)
  const replacement = PairingPollResponse.parse(
    await (
      await machine('claim', { device_code: second.started.device_code })
    ).json(),
  )
  expect(replacement.status).toBe('approved')

  // Force a deferred failure at the real credential transaction commit boundary.
  const commitFailure = await begin()
  expect(
    (
      await browserPost('/api/connector-pairing/approve', {
        ...approval,
        user_code: commitFailure.started.user_code,
      })
    ).status,
  ).toBe(200)
  const admin = postgres({
    host: '127.0.0.1',
    port: Number(databasePort),
    database: 'fixture',
    username: 'fixture',
    max: 1,
    connect_timeout: 3,
  })
  try {
    await admin
      .unsafe(
        `CREATE FUNCTION farm.fail_http_commit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_http_commit_fixture AFTER INSERT ON farm.connector_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.fail_http_commit_fixture();`,
      )
      .simple()
    try {
      const failed = await machine('claim', {
        device_code: commitFailure.started.device_code,
      })
      expect(failed.ok).toBe(false)
      const body = await failed.text()
      expect(
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(body),
      ).toBe(false)
      const rows =
        await admin`SELECT count(*)::int AS n FROM farm.connector_credentials WHERE agent_id=${commitFailure.challenge.agent_id}::uuid`
      expect(rows[0]?.n).toBe(0)
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER fail_http_commit_fixture ON farm.connector_credentials; DROP FUNCTION farm.fail_http_commit_fixture();',
        )
        .simple()
    }
    const retry = PairingPollResponse.parse(
      await (
        await machine('claim', {
          device_code: commitFailure.started.device_code,
        })
      ).json(),
    )
    expect(retry.status).toBe('approved')
  } finally {
    await admin.end({ timeout: 3 })
  }
  const openActor = async (name: string) => {
    const actor = await page
      .context()
      .browser()!
      .newContext({ ignoreHTTPSErrors: true })
    const actorPage = await actor.newPage()
    trackPage(actorPage)
    await actorPage.goto(origin + '/entrar')
    await actorPage.getByLabel('Usuário').fill(name)
    await actorPage.getByLabel('Senha').fill(password)
    await actorPage.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(actorPage).not.toHaveURL(/\/entrar$/)
    return { actor, actorPage }
  }
  const postAs = (actorPage: typeof page, body: unknown) =>
    actorPage.evaluate(async (input) => {
      const response = await fetch('/api/connector-pairing/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      return response.status
    }, body)
  const roleCase = await begin()
  const expiredContext = await page
    .context()
    .browser()!
    .newContext({ ignoreHTTPSErrors: true })
  await expiredContext.addCookies([
    {
      name: '__Host-open3dfarmmanager-session',
      value: expiredCookie,
      url: url.origin,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  const expiredPage = await expiredContext.newPage()
  trackPage(expiredPage)
  await expiredPage.goto(origin + '/entrar')
  const expiredSessionCase = roleCase
  expect(
    await postAs(expiredPage, {
      ...approval,
      user_code: expiredSessionCase.started.user_code,
    }),
  ).toBeGreaterThanOrEqual(400)
  await expiredContext.close()
  const operator = await openActor(operatorUsername)
  const administrator = await openActor(adminUsername)
  const roleApproval = { ...approval, user_code: roleCase.started.user_code }
  expect(await postAs(operator.actorPage, roleApproval)).toBeGreaterThanOrEqual(
    400,
  )
  expect(await postAs(administrator.actorPage, roleApproval)).toBe(200)
  const roleClaim = PairingPollResponse.parse(
    await (
      await machine('claim', { device_code: roleCase.started.device_code })
    ).json(),
  )
  expect(roleClaim.status).toBe('approved')
  if (roleClaim.status === 'approved')
    connectorSecrets.push(roleClaim.device_token)
  browserBytes.push(
    await operator.actorPage.evaluate(
      () =>
        document.documentElement.outerHTML +
        JSON.stringify(localStorage) +
        JSON.stringify(sessionStorage),
    ),
  )
  await operator.actor.close()

  const lost = await begin()
  expect(
    (
      await browserPost('/api/connector-pairing/approve', {
        ...approval,
        user_code: lost.started.user_code,
      })
    ).status,
  ).toBe(200)
  let disconnected = false
  try {
    await machine(
      'claim',
      { device_code: lost.started.device_code },
      { 'x-fixture-drop': dropControl },
    )
  } catch {
    disconnected = true
  }
  expect(disconnected).toBe(true)
  const lostInventory = await page.evaluate(
    async (id) => (await fetch(`/api/farms/${id}/connectors`)).text(),
    farmId,
  )
  expect(lostInventory.includes(lost.challenge.agent_id)).toBe(true)
  expect(lostInventory.includes(identity.fingerprint)).toBe(true)
  expect(
    (
      await browserPost(
        `/api/farms/${farmId}/connectors/${lost.challenge.agent_id}/revoke`,
        { expected_fingerprint: identity.fingerprint },
      )
    ).status,
  ).toBe(200)
  const recovered = await begin()
  expect(
    (
      await browserPost('/api/connector-pairing/approve', {
        ...approval,
        user_code: recovered.started.user_code,
      })
    ).status,
  ).toBe(200)
  const recoveredClaim = PairingPollResponse.parse(
    await (
      await machine('claim', { device_code: recovered.started.device_code })
    ).json(),
  )
  expect(recoveredClaim.status).toBe('approved')
  if (recoveredClaim.status === 'approved')
    connectorSecrets.push(recoveredClaim.device_token)

  const lockCase = await begin()
  const lockSql = postgres({
    host: '127.0.0.1',
    port: Number(databasePort),
    database: 'fixture',
    username: 'fixture',
    max: 3,
    connect_timeout: 3,
  })
  const held = await lockSql.reserve()
  try {
    await held`BEGIN`
    await held`UPDATE farm.memberships SET revoked_at=${Date.now()} WHERE farm_id=${farmId}::uuid AND account_id=${adminAccount}`
    const pending = postAs(administrator.actorPage, {
      ...approval,
      user_code: lockCase.started.user_code,
    })
    const deadline = Date.now() + 700
    while (true) {
      const waiting =
        await lockSql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM farm.memberships%'`
      if (waiting[0]?.n > 0) break
      if (Date.now() >= deadline)
        throw new Error('Approval did not wait on membership lock')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await held`COMMIT`
    expect(await pending).toBeGreaterThanOrEqual(400)
  } finally {
    await held`ROLLBACK`.catch(() => {})
    held.release()
    await lockSql.end({ timeout: 3 })
    browserBytes.push(
      await administrator.actorPage.evaluate(
        () =>
          document.documentElement.outerHTML +
          JSON.stringify(localStorage) +
          JSON.stringify(sessionStorage),
      ),
    )
    await administrator.actor.close()
  }

  const expiry = await begin()
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, expiry.challenge.expires_at - Date.now() + 50),
    ),
  )
  expect(
    (
      await browserPost('/api/connector-pairing/approve', {
        ...approval,
        user_code: expiry.started.user_code,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400)
  const expiredClaim = await machine('claim', {
    device_code: expiry.started.device_code,
  })
  expect(expiredClaim.ok).toBe(false)
  expect(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(
      await expiredClaim.text(),
    ),
  ).toBe(false)

  const revokedSessionCase = await begin()
  const revokeSessions = postgres({
    host: '127.0.0.1',
    port: Number(databasePort),
    database: 'fixture',
    username: 'fixture',
    max: 1,
    connect_timeout: 3,
  })
  try {
    await revokeSessions`UPDATE farm.account_sessions SET revoked_at=${Date.now()} WHERE account_id=${ownerAccount} AND revoked_at IS NULL`
    expect(
      (
        await browserPost('/api/connector-pairing/approve', {
          ...approval,
          user_code: revokedSessionCase.started.user_code,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400)
  } finally {
    await revokeSessions.end({ timeout: 3 })
  }
  await Promise.all(responseReads)
  const browserState = await page.evaluate(
    () =>
      document.documentElement.outerHTML +
      JSON.stringify(localStorage) +
      JSON.stringify(sessionStorage),
  )
  const visible = browserBytes.join('\n') + browserState
  for (const secret of connectorSecrets)
    expect(visible.includes(secret)).toBe(false)
  expect(/\"device_token\"\s*:/.test(browserBytes.join('\n'))).toBe(false)
})
