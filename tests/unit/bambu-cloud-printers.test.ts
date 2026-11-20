import { afterAll, beforeAll, expect, test } from 'vitest'
import { createLogger } from '@open3dfarmmanager/shared'
import { startMock } from '../../packages/sim-tools/src/mocks/index.ts'
import type { BambuCloudMockInstance } from '../../packages/sim-tools/src/mocks/bambu-cloud-mock.ts'
import {
  connectBambuCloudAccount,
  MemoryBambuCloudAccountStore,
} from '../../apps/farm/server/utils/bambu-cloud/account.ts'
import {
  listBambuCloudAccountPrinters,
  normalizeBambuCloudDevices,
} from '../../apps/farm/server/utils/bambu-cloud/import-printers.ts'
import {
  listImportableBambuCloudPrinters,
  memoryBambuCloudImportCredentials,
} from '../../apps/farm/server/utils/bambu-cloud/import-printers-http.ts'
import { openBambuCloudSecret } from '../../apps/farm/server/utils/bambu-cloud/secret.ts'
import {
  bambuCloudPrinterLabel,
  prefillBambuSetupFromCloudPrinter,
} from '../../apps/farm/app/utils/bambu-cloud-printers.ts'

const MASTER = 'test-session-secret-32chars-minimum!!'
const FARM = '11111111-1111-4111-8111-111111111111'
const OWNER = 'owner-1'
const OPERATOR = 'operator-1'
const ACCESS = 'plain-bambu-access-NEVER-SHOW-7f3a'
const REFRESH = 'plain-bambu-refresh-NEVER-SHOW-7f3a'
const CODE = '864209'
const EMAIL = 'owner@example.com'
const NOW = new Date('2026-11-19T12:00:00.000Z')
const POLICY = { bambuCloud: true }
const SERIAL_A = '01P00A000000001'
const SERIAL_B = '01P00A000000002'

let cloud: BambuCloudMockInstance
const lines: string[] = []
const seen: string[] = []
const logger = createLogger('bambu-cloud-printers-test', (line) => {
  lines.push(line)
})

function remember(value: unknown) {
  seen.push(JSON.stringify(value))
  return value
}

function secretsAbsent() {
  const blob = `${lines.join('\n')}\n${seen.join('\n')}`
  for (const secret of [ACCESS, REFRESH, CODE])
    expect(blob).not.toContain(secret)
}

beforeAll(async () => {
  cloud = await startMock('bambu-cloud', {
    account: EMAIL,
    emailCode: CODE,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresIn: 3600,
    devices: [
      {
        dev_id: SERIAL_A,
        name: 'Studio A',
        dev_model_name: 'X1C',
        nozzle_diameter: 0.4,
      },
      {
        dev_id: SERIAL_A,
        name: 'Studio A duplicate',
        dev_model_name: 'X1C',
        nozzle_diameter: 0.4,
      },
      {
        dev_id: SERIAL_B,
        name: 'Studio B',
        dev_model_name: 'P1S',
        nozzle_diameter: 0.6,
      },
      {
        dev_id: 'short',
        name: 'Bad',
        dev_model_name: 'X1C',
        nozzle_diameter: 0.4,
      },
      {
        dev_id: '01P00A000000099',
        name: '',
        dev_model_name: 'X1C',
        nozzle_diameter: 0.4,
      },
      {
        dev_id: '01P00A000000098',
        name: 'No nozzle',
        dev_model_name: 'X1C',
        nozzle_diameter: 0,
      },
      { not: 'a device' } as unknown as {
        dev_id: string
        name: string
        dev_model_name: string
        nozzle_diameter: number
      },
    ],
  })
})

afterAll(async () => {
  await cloud.close()
})

test('normalize skips malformed rows and dedupes by serial', () => {
  const result = normalizeBambuCloudDevices(
    [
      {
        dev_id: SERIAL_A,
        name: 'First',
        dev_model_name: 'X1C',
        nozzle_diameter: 0.4,
      },
      {
        dev_id: SERIAL_A,
        name: 'Again',
        dev_model_name: 'X1C',
        nozzle_diameter: 0.4,
      },
      {
        dev_id: SERIAL_B,
        name: 'Second',
        dev_model_name: 'P1S',
        nozzle_diameter: 0.6,
      },
      { dev_id: 'bad', name: 'x', dev_model_name: 'y', nozzle_diameter: 0.4 },
      null,
    ],
    [SERIAL_B],
  )
  expect(result).toEqual({
    ok: true,
    printers: [
      {
        serial: SERIAL_A,
        name: 'First',
        model: 'X1C',
        nozzle: 0.4,
      },
    ],
    skippedMalformed: 2,
  })
})

test('owner lists account printers from the loopback cloud without leaking the token', async () => {
  const store = new MemoryBambuCloudAccountStore(MASTER)
  store.setMember(FARM, OWNER, 'owner')
  store.setMember(FARM, OPERATOR, 'operator')
  const deps = { now: NOW, logger, policy: POLICY }

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
  expect(connected).toMatchObject({ ok: true, account: { connected: true } })
  const sealed = store.inspect(FARM)
  expect(sealed).not.toBeNull()
  expect(openBambuCloudSecret(sealed!.access, MASTER)).toBe(ACCESS)

  const denied = remember(
    await listImportableBambuCloudPrinters({
      store,
      credentials: memoryBambuCloudImportCredentials(
        store,
        MASTER,
        cloud.origin,
      ),
      actor: { farmId: FARM, accountId: OPERATOR },
      policy: POLICY,
    }),
  )
  expect(denied).toEqual({ ok: false, reason: 'forbidden' })

  const listed = remember(
    await listImportableBambuCloudPrinters({
      store,
      credentials: memoryBambuCloudImportCredentials(
        store,
        MASTER,
        cloud.origin,
      ),
      actor: { farmId: FARM, accountId: OWNER },
      policy: POLICY,
      knownSerials: [SERIAL_B],
    }),
  )
  expect(listed).toEqual({
    ok: true,
    printers: [
      {
        serial: SERIAL_A,
        name: 'Studio A',
        model: 'X1C',
        nozzle: 0.4,
      },
    ],
    skippedMalformed: 4,
  })
  expect(
    cloud.calls()['GET /v1/iot-service/api/user/bind'] ?? 0,
  ).toBeGreaterThan(0)

  const direct = remember(
    await listBambuCloudAccountPrinters({
      endpoint: cloud.origin,
      accessToken: ACCESS,
      policy: POLICY,
      logger,
      farmId: FARM,
    }),
  )
  expect(direct).toMatchObject({
    ok: true,
    printers: [
      { serial: SERIAL_A, name: 'Studio A' },
      { serial: SERIAL_B, name: 'Studio B' },
    ],
    skippedMalformed: 4,
  })

  const family = { value: 'klipper-moonraker' }
  const serial = { value: '' }
  const label = { value: '' }
  prefillBambuSetupFromCloudPrinter(
    {
      serial: SERIAL_A,
      name: 'Studio A',
      model: 'X1C',
      nozzle: 0.4,
    },
    {
      onboardingFamily: family,
      bambuSerial: serial,
      kobraLabel: label,
    },
  )
  expect(family.value).toBe('bambu-lan')
  expect(serial.value).toBe(SERIAL_A)
  expect(label.value).toBe('Studio A')
  expect(
    bambuCloudPrinterLabel({
      serial: SERIAL_A,
      name: 'Studio A',
      model: 'X1C',
      nozzle: 0.4,
    }),
  ).toContain(SERIAL_A)

  const blocked = remember(
    await listBambuCloudAccountPrinters({
      endpoint: 'https://api.bambulab.com',
      accessToken: ACCESS,
      policy: POLICY,
      fetchImpl: async () => {
        throw new Error('no-network')
      },
    }),
  )
  expect(blocked).toEqual({ ok: false, reason: 'cloud-rejected' })
  secretsAbsent()
})
