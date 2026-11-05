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
const databasePort = process.env.PAIRING_HTTP_SYNTHETIC_TEST_PORT
const enabled = process.env.PAIRING_HTTP_TEST_DISPOSABLE === 'yes'

test('real HTTPS pairing, lost claim recovery and fresh pairing', async ({
  page,
}) => {
  test.skip(!enabled, 'Requires explicit disposable pairing HTTP fixture')
  if (
    !origin ||
    !username ||
    !password ||
    !farmId ||
    !otherFarmId ||
    !publicKeyFile ||
    !keyId ||
    !databasePort
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
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
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
      request.on('error', reject)
      request.end(payload)
    })
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
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

  async function begin() {
    const response = await machine('start', request)
    expect(response.ok).toBe(true)
    const started = PairingStartResponse.parse(await response.json())
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
    expect((await machine('proof', proof)).ok).toBe(false)
    return { started, challenge }
  }
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
})
