import { connect as tlsConnect } from 'node:tls'
import { expect, test } from '@playwright/test'
import { MqttClient } from 'mqtt'
import { createLogger } from '@open3dfarmmanager/shared'
import { readBambuCloudAms } from '../../packages/connector/src/bambu/cloud-ams.ts'
import { getSharedThrowawayTls } from '../../packages/sim-tools/src/mocks/tls.ts'
import {
  startBambuCloudMock,
  type BambuCloudTask,
} from '../../packages/sim-tools/src/mocks/bambu-cloud-mock.ts'
import {
  connectBambuCloudAccount,
  MemoryBambuCloudAccountStore,
} from '../../apps/farm/server/utils/bambu-cloud/account.ts'
import { fetchBambuCloudHistory } from '../../apps/farm/server/utils/bambu-cloud/import-history.ts'
import { listBambuCloudAccountPrinters } from '../../apps/farm/server/utils/bambu-cloud/import-printers.ts'
import { openBambuCloudSecret } from '../../apps/farm/server/utils/bambu-cloud/secret.ts'

const MASTER = 'test-session-secret-32chars-minimum!!'
const FARM = '11111111-1111-4111-8111-111111111111'
const OWNER = 'owner-1'
const OPERATOR = 'operator-1'
const ACCESS = 'plain-bambu-access-NEVER-SHOW-7f3a'
const REFRESH = 'plain-bambu-refresh-NEVER-SHOW-7f3a'
const CODE = '864209'
const EMAIL = 'owner@example.com'
const SERIAL = '01P00A000000001'
const POLICY = { bambuCloud: true }
// The fake cloud serves task objects verbatim and the history importer reads
// the printer serial from dev_id, so the payload keeps that field.
const TASKS: (BambuCloudTask & { dev_id: string })[] = [
  {
    id: 'task-1',
    dev_id: SERIAL,
    title: 'Benchy',
    status: 'success',
    start: 1_700_000_000,
    end: 1_700_003_600,
    weight: 12,
    filaments: [{ slot: 0, grams: 12 }],
  },
]

test('connects a loopback Bambu cloud and reads printers, history and AMS', async ({
  request,
}) => {
  const lines: string[] = []
  const cloud = await startBambuCloudMock({
    account: EMAIL,
    emailCode: CODE,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresIn: 3600,
    devices: [
      {
        dev_id: SERIAL,
        name: 'Studio A',
        dev_model_name: 'X1C',
        nozzle_diameter: 0.4,
      },
    ],
    tasks: TASKS,
  })
  const store = new MemoryBambuCloudAccountStore(MASTER)
  store.setMember(FARM, OWNER, 'owner')
  store.setMember(FARM, OPERATOR, 'operator')
  const deps = {
    now: new Date('2026-11-19T12:00:00.000Z'),
    logger: createLogger('epic-282', (line) => {
      lines.push(line)
    }),
    policy: POLICY,
  }
  let ams: { stop: () => void } | undefined
  try {
    const denied = await request.get(
      `${cloud.origin}/v1/iot-service/api/user/bind`,
    )
    expect(denied.status()).toBe(401)

    const loginsBefore = cloud.calls()['POST /v1/user-service/user/login'] ?? 0
    const forbidden = await connectBambuCloudAccount(
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
    )
    expect(forbidden).toEqual({ ok: false, reason: 'forbidden' })
    expect(cloud.calls()['POST /v1/user-service/user/login'] ?? 0).toBe(
      loginsBefore,
    )

    const connected = await connectBambuCloudAccount(
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
    )
    expect(connected).toMatchObject({
      ok: true,
      account: {
        connected: true,
        region: 'global',
        account: EMAIL,
        expired: false,
        mqtt: { host: '127.0.0.1', port: cloud.mqtt.port, username: 'u_mock' },
      },
    })
    if (!connected.ok || !('account' in connected) || !connected.account.mqtt)
      throw new Error('Loopback account did not return a broker')
    const sealed = store.inspect(FARM)
    expect(sealed).not.toBeNull()
    expect(openBambuCloudSecret(sealed!.access, MASTER)).toBe(ACCESS)
    expect(openBambuCloudSecret(sealed!.refresh!, MASTER)).toBe(REFRESH)
    expect(lines.join('\n')).not.toContain(ACCESS)
    expect(lines.join('\n')).not.toContain(REFRESH)
    expect(lines.join('\n')).not.toContain(CODE)

    const printers = await listBambuCloudAccountPrinters({
      endpoint: cloud.origin,
      accessToken: ACCESS,
      policy: POLICY,
      farmId: FARM,
      logger: deps.logger,
    })
    expect(printers).toEqual({
      ok: true,
      printers: [
        { serial: SERIAL, name: 'Studio A', model: 'X1C', nozzle: 0.4 },
      ],
      skippedMalformed: 0,
    })

    const history = await fetchBambuCloudHistory({
      endpoint: cloud.origin,
      accessToken: ACCESS,
      policy: POLICY,
    })
    expect(history).toEqual({
      ok: true,
      skipped: 0,
      tasks: [
        {
          id: 'task-1',
          serial: SERIAL,
          title: 'Benchy',
          outcome: 'completed',
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_003_600_000,
          totalGrams: 12,
          filamentUsage: [{ tool: 'slot-0', grams: 12 }],
        },
      ],
    })

    ams = await armAmsReply({
      port: connected.account.mqtt.port,
      serial: SERIAL,
      ca: getSharedThrowawayTls().ca.cert,
    })
    const materials = await readBambuCloudAms({
      host: connected.account.mqtt.host,
      port: connected.account.mqtt.port,
      serial: SERIAL,
      username: connected.account.mqtt.username,
      accessToken: ACCESS,
      ca: getSharedThrowawayTls().ca.cert,
    })
    expect(materials).toMatchObject([
      {
        slot: 'ams:0:0',
        materialType: 'PLA',
        remainingPercent: 37,
        active: true,
      },
    ])
    expect(cloud.calls()['POST /v1/user-service/user/login']).toBeGreaterThan(0)
    expect(cloud.calls()['GET /v1/iot-service/api/user/bind']).toBeGreaterThan(
      0,
    )
    expect(cloud.calls()['GET /v1/user-service/my/tasks']).toBeGreaterThan(0)
    expect(cloud.calls()['GET /v1/iot-service/api/user/mqtt']).toBeGreaterThan(
      0,
    )
    expect(cloud.origin.startsWith('http://127.0.0.1:')).toBe(true)
  } finally {
    ams?.stop()
    await cloud.close()
  }
})

function armAmsReply(input: {
  port: number
  serial: string
  ca: Buffer
}): Promise<{ stop: () => void }> {
  const requestTopic = `device/${input.serial}/request`
  const reportTopic = `device/${input.serial}/report`
  return new Promise((resolve, reject) => {
    const client = new MqttClient(
      () =>
        tlsConnect({
          host: '127.0.0.1',
          port: input.port,
          ca: input.ca,
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
        }),
      {
        manualConnect: true,
        protocolVersion: 4,
        username: 'ams-fixture',
        password: 'ams-fixture-password',
        connectTimeout: 5000,
        reconnectPeriod: 0,
        clean: true,
        resubscribe: false,
        queueQoSZero: false,
      },
    )
    const timer = setTimeout(() => {
      client.end(true)
      reject(new Error('AMS fixture did not subscribe'))
    }, 5000)
    const fail = (error: Error) => {
      clearTimeout(timer)
      client.end(true)
      reject(error)
    }
    client.on('error', fail)
    client.on('message', (topic) => {
      if (topic !== requestTopic) return
      client.publish(
        reportTopic,
        JSON.stringify({
          print: {
            ams: {
              tray_now: '0',
              ams: [
                {
                  id: '0',
                  tray: [{ id: '0', tray_type: 'PLA', remain: 37 }],
                },
              ],
            },
          },
        }),
        { qos: 0, retain: false },
      )
    })
    client.on('connect', () => {
      client.subscribe(requestTopic, { qos: 0 }, (error) => {
        if (error) {
          fail(error)
          return
        }
        clearTimeout(timer)
        resolve({
          stop: () => {
            client.end(true)
          },
        })
      })
    })
    client.connect()
  })
}
