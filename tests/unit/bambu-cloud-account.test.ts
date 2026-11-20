import { afterAll, beforeAll, expect, test } from 'vitest'
import { createLogger } from '@open3dfarmmanager/shared'
import { startMock } from '../../packages/sim-tools/src/mocks/index.ts'
import type { BambuCloudMockInstance } from '../../packages/sim-tools/src/mocks/bambu-cloud-mock.ts'
import { loginBambuCloud } from '../../apps/farm/server/utils/bambu-cloud/cloud-client.ts'
import { openBambuCloudSecret } from '../../apps/farm/server/utils/bambu-cloud/secret.ts'
import {
  connectBambuCloudAccount,
  disconnectBambuCloudAccount,
  MemoryBambuCloudAccountStore,
  type BambuCloudConnectResult,
} from '../../apps/farm/server/utils/bambu-cloud/account.ts'

const MASTER = 'test-session-secret-32chars-minimum!!'
const FARM = '11111111-1111-4111-8111-111111111111'
const OWNER = 'owner-1'
const OPERATOR = 'operator-1'
const ACCESS = 'plain-bambu-access-NEVER-SHOW-7f3a'
const REFRESH = 'plain-bambu-refresh-NEVER-SHOW-7f3a'
const PASTED = 'plain-bambu-pasted-NEVER-SHOW-7f3a'
const CODE = '864209'
const PASSWORD = 'owner-password-NEVER-LOG'
const TFA_CODE = '445566'
const EMAIL = 'owner@example.com'
const NOW = new Date('2026-11-19T12:00:00.000Z')
const POLICY = { bambuCloud: true }

let cloud: BambuCloudMockInstance
const lines: string[] = []
const seen: string[] = []
const logger = createLogger('bambu-cloud-test', (line) => {
  lines.push(line)
})

function remember(result: BambuCloudConnectResult) {
  seen.push(JSON.stringify(result))
  return result
}

function secretsAbsent() {
  const blob = `${lines.join('\n')}\n${seen.join('\n')}`
  for (const secret of [ACCESS, REFRESH, PASTED, CODE, PASSWORD, TFA_CODE])
    expect(blob).not.toContain(secret)
}

beforeAll(async () => {
  cloud = await startMock('bambu-cloud', {
    account: EMAIL,
    password: PASSWORD,
    emailCode: CODE,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresIn: 3600,
  })
})

afterAll(async () => {
  await cloud.close()
})

test('owner connects and disconnects through the loopback cloud without leaking the token', async () => {
  const store = new MemoryBambuCloudAccountStore(MASTER)
  store.setMember(FARM, OWNER, 'owner')
  store.setMember(FARM, OPERATOR, 'operator')
  const deps = { now: NOW, logger, policy: POLICY }

  const loginsBefore = cloud.calls()['POST /v1/user-service/user/login'] ?? 0
  const denied = remember(
    await connectBambuCloudAccount(
      store,
      { farmId: FARM, accountId: OPERATOR },
      {
        mode: 'email-code',
        account: EMAIL,
        code: CODE,
        region: 'global',
        endpoint: cloud.origin,
      },
      deps,
    ),
  )
  expect(denied).toEqual({ ok: false, reason: 'forbidden' })
  expect(cloud.calls()['POST /v1/user-service/user/login'] ?? 0).toBe(
    loginsBefore,
  )

  const connected = remember(
    await connectBambuCloudAccount(
      store,
      { farmId: FARM, accountId: OWNER },
      {
        mode: 'email-code',
        account: EMAIL,
        code: CODE,
        region: 'global',
        endpoint: cloud.origin,
      },
      deps,
    ),
  )
  expect(connected).toMatchObject({
    ok: true,
    account: {
      connected: true,
      region: 'global',
      account: EMAIL,
      expired: false,
      expiresAt: '2026-11-19T13:00:00.000Z',
      mqtt: { host: '127.0.0.1', username: 'u_mock' },
    },
  })
  const sealed = store.inspect(FARM)
  expect(sealed).not.toBeNull()
  expect(sealed!.access.ciphertext.includes(Buffer.from(ACCESS))).toBe(false)
  expect(sealed!.refresh!.ciphertext.includes(Buffer.from(REFRESH))).toBe(false)
  expect(openBambuCloudSecret(sealed!.access, MASTER)).toBe(ACCESS)
  expect(openBambuCloudSecret(sealed!.refresh!, MASTER)).toBe(REFRESH)

  const gone = remember(
    await disconnectBambuCloudAccount(
      store,
      { farmId: FARM, accountId: OWNER },
      deps,
    ),
  )
  expect(gone).toEqual({
    ok: true,
    account: {
      connected: false,
      region: null,
      account: null,
      expiresAt: null,
      expired: false,
      mqtt: null,
    },
  })
  expect(store.inspect(FARM)).toBeNull()

  cloud.control.setExpiresIn(-60)
  const expired = remember(
    await connectBambuCloudAccount(
      store,
      { farmId: FARM, accountId: OWNER },
      {
        mode: 'email-code',
        account: EMAIL,
        code: CODE,
        region: 'china',
        endpoint: cloud.origin,
      },
      deps,
    ),
  )
  expect(expired).toMatchObject({
    ok: true,
    account: {
      connected: true,
      expired: true,
      region: 'china',
      expiresAt: '2026-11-19T11:59:00.000Z',
    },
  })
  expect(
    store.inspect(FARM)!.access.ciphertext.includes(Buffer.from(ACCESS)),
  ).toBe(false)
  await disconnectBambuCloudAccount(
    store,
    { farmId: FARM, accountId: OWNER },
    deps,
  )

  cloud.control.setExpiresIn(3600)
  cloud.control.setTfaCode(TFA_CODE)
  const challenge = remember(
    await connectBambuCloudAccount(
      store,
      { farmId: FARM, accountId: OWNER },
      {
        mode: 'password',
        account: EMAIL,
        password: PASSWORD,
        region: 'global',
        endpoint: cloud.origin,
      },
      deps,
    ),
  )
  expect(challenge.ok).toBe(true)
  if (!challenge.ok || !('tfaRequired' in challenge))
    throw new Error('expected a 2FA challenge')
  expect(challenge.tfaKey).not.toBe(ACCESS)
  expect(store.inspect(FARM)).toBeNull()
  const finished = remember(
    await connectBambuCloudAccount(
      store,
      { farmId: FARM, accountId: OWNER },
      {
        mode: 'tfa',
        account: EMAIL,
        tfaKey: challenge.tfaKey,
        tfaCode: TFA_CODE,
        region: 'global',
        endpoint: cloud.origin,
      },
      deps,
    ),
  )
  expect(finished).toMatchObject({
    ok: true,
    account: { connected: true, expired: false },
  })
  await disconnectBambuCloudAccount(
    store,
    { farmId: FARM, accountId: OWNER },
    deps,
  )

  const pasted = remember(
    await connectBambuCloudAccount(
      store,
      { farmId: FARM, accountId: OWNER },
      {
        mode: 'token',
        account: EMAIL,
        accessToken: PASTED,
        expiresAt: '2020-01-01T00:00:00.000Z',
        region: 'global',
      },
      deps,
    ),
  )
  expect(pasted).toMatchObject({
    ok: true,
    account: {
      connected: true,
      expired: true,
      expiresAt: '2020-01-01T00:00:00.000Z',
    },
  })
  expect(openBambuCloudSecret(store.inspect(FARM)!.access, MASTER)).toBe(PASTED)
  expect(store.inspect(FARM)!.refresh).toBeNull()
  secretsAbsent()
})

test('login stays on the loopback fake and never calls a real Bambu host', async () => {
  let called = false
  const blocked = await loginBambuCloud({
    endpoint: 'https://api.bambulab.com',
    policy: POLICY,
    now: NOW,
    body: { account: EMAIL, code: CODE },
    fetchImpl: async () => {
      called = true
      throw new Error('no-network')
    },
  })
  expect(called).toBe(false)
  expect(blocked).toEqual({ ok: false, reason: 'cloud-rejected' })
  const disabled = await loginBambuCloud({
    endpoint: cloud.origin,
    policy: { bambuCloud: false },
    now: NOW,
    body: { account: EMAIL, code: CODE },
    fetchImpl: async () => {
      called = true
      throw new Error('no-network')
    },
  })
  expect(called).toBe(false)
  expect(disabled).toEqual({ ok: false, reason: 'cloud-disabled' })
})

test('fake cloud serves refresh, devices, task history and mqtt broker info', async () => {
  const login = await fetch(`${cloud.origin}/v1/user-service/user/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: EMAIL, code: CODE }),
  })
  const tokens = (await login.json()) as {
    accessToken: string
    refreshToken: string
  }
  expect(tokens.accessToken).toBe(ACCESS)
  const headers = { authorization: `Bearer ${tokens.accessToken}` }
  const devices = (await (
    await fetch(`${cloud.origin}/v1/iot-service/api/user/bind`, { headers })
  ).json()) as { devices: { dev_id: string; dev_model_name: string }[] }
  expect(devices.devices[0]).toMatchObject({
    dev_id: 'SYNTHETIC',
    dev_model_name: 'X1C',
  })
  const tasks = (await (
    await fetch(`${cloud.origin}/v1/user-service/my/tasks`, { headers })
  ).json()) as { hits: { id: string; status: string; weight: number }[] }
  expect(tasks.hits[0]).toMatchObject({ id: 'task-1', status: 'success' })
  const mqtt = (await (
    await fetch(`${cloud.origin}/v1/iot-service/api/user/mqtt`, { headers })
  ).json()) as { host: string; port: number; username: string }
  expect(mqtt).toMatchObject({
    host: '127.0.0.1',
    port: cloud.mqtt.port,
    username: 'u_mock',
  })
  expect(JSON.stringify(mqtt)).not.toContain(ACCESS)
  const refreshed = (await (
    await fetch(`${cloud.origin}/v1/user-service/user/refreshtoken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    })
  ).json()) as { accessToken: string }
  expect(refreshed.accessToken).not.toBe(ACCESS)
  const after = await fetch(`${cloud.origin}/v1/iot-service/api/user/bind`, {
    headers: { authorization: `Bearer ${refreshed.accessToken}` },
  })
  expect(after.status).toBe(200)
})
