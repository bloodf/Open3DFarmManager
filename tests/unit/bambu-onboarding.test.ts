import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { transformSync } from 'esbuild'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  BambuConfigurationTarget,
  ConfigurationTarget,
  configurationTargetHash,
} from '../../packages/farm-protocol/src/configuration-target.ts'
import { configurationReceiptHash } from '../../packages/farm-protocol/src/configuration-receipt.ts'
import {
  decodeConfigurationRequest,
  encodeConfigurationRequest,
  encodeConfigurationResponse,
  type ConfigurationRequestFrame,
} from '../../packages/farm-protocol/src/configuration-frames.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { createProvisioningEngine } from '../../packages/connector/src/provisioning/engine.ts'
import {
  trustProvisioningAuthority,
  type ProvisioningContext,
} from '../../packages/connector/src/provisioning/authority.ts'
import {
  bambuIdentity,
  probeBambuLan,
  type BambuProbe,
} from '../../packages/connector/src/provisioning/bambu.ts'
import {
  bambuBindingsPath,
  parseBambuOnboardedConfig,
} from '../../packages/connector/src/config/bambu.ts'
import { readBambuCredentials } from '../../packages/connector/src/bambu/credentials.ts'
import {
  provisionBambuPrinter,
  readBambuPrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import {
  BAMBU_LAN_COMMAND_NOTE,
  describeBambuConfigurationError,
  describeBambuTarget,
  validateBambuTargetInput,
  withoutBambuAccessCode,
} from '../../apps/farm/app/utils/bambu-onboarding.ts'

const SERIAL = '01S00C123456789'
const CODE = 'Synth3t1cC0de'
const PIN = 'ab'.repeat(32)
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function target(
  input: Partial<Parameters<typeof validateBambuTargetInput>[0]> = {},
) {
  const value = validateBambuTargetInput({
    ipv4: '192.168.1.60',
    serial: SERIAL,
    accessCode: CODE,
    ...input,
  })
  if (!value.ok) throw new Error(value.error)
  return value.target
}
function world(options: { reachable?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bambu-onboarding-')))
  directories.push(dir)
  const signer = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  ).configurationReceiptSigner()
  const scope = {
    runtimeConfigPath: join(dir, 'runtime.json'),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
  }
  let current = true
  const probes: Parameters<BambuProbe>[0][] = []
  const probedCodes: string[] = []
  const diagnostics: unknown[] = []
  const acknowledgements: unknown[] = []
  const engine = createProvisioningEngine({
    stateDirectory: join(dir, 'state'),
    runtime: scope,
    connector: signer,
    managedBridge: null,
    printerNetworks: ['192.168.1.0/24'],
    // Fixture only: no socket is opened and nothing reaches a printer.
    bambuProbe: async (input) => {
      probes.push(input)
      probedCodes.push(
        JSON.parse(readFileSync(input.credentialFile, 'utf8')).accessCode,
      )
      return options.reachable === false
        ? { ok: false }
        : { ok: true, pinSha256: PIN }
    },
    authority: trustProvisioningAuthority({
      async isCurrent(context) {
        return current && context.role === 'admin'
      },
      async acceptsInventoryAck(request) {
        acknowledgements.push(request)
        return request.attestation === 'fixture-attestation'
      },
    }),
    onDurableStage(stage, operationId) {
      diagnostics.push({ stage, operationId })
    },
  })
  const binding = {
    account_id: 'test-admin',
    role: 'admin' as const,
    farm_id: scope.farm_id,
    agent_id: scope.agent_id,
    key_id: randomUUID(),
    credential_jti: randomUUID(),
    transport_id: randomUUID(),
    connector_fingerprint: signer.fingerprint,
  }
  const context = (
    action: ProvisioningContext['action'],
  ): ProvisioningContext => ({
    ...binding,
    action,
    capability_id: randomUUID(),
    admission_nonce: 'A'.repeat(43),
  })
  return {
    dir,
    engine,
    scope,
    context,
    probes,
    probedCodes,
    diagnostics,
    acknowledgements,
    bindingsPath: bambuBindingsPath(scope.runtimeConfigPath),
    credentials: () => readdirSync(join(dir, 'state', 'credentials')),
    send: (frame: ConfigurationRequestFrame) =>
      engine.handle({ frame, context: context(frame.type) }),
    revoke() {
      current = false
    },
  }
}
function prepareFrame(input: ReturnType<typeof target>, revision = 0) {
  return {
    v: 1,
    protocol: 'config-v1',
    type: 'prepare',
    request_id: randomUUID(),
    operation_id: randomUUID(),
    expected_revision: revision,
    target: input,
  } as const
}
async function apply(
  w: ReturnType<typeof world>,
  input: ReturnType<typeof target>,
  revision = 0,
) {
  const prepare = prepareFrame(input, revision)
  const prepared = await w.send(prepare)
  if (prepared.type !== 'result')
    throw new Error('Fixture prepare failed: ' + JSON.stringify(prepared))
  expect(prepared.state).toBe('prepared')
  const commit = {
    v: 1,
    protocol: 'config-v1',
    type: 'commit',
    request_id: randomUUID(),
    operation_id: prepare.operation_id,
    expected_revision: revision,
    target_sha256: await configurationTargetHash(input),
    prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
  } as const
  const committed = await w.send(commit)
  if (committed.type !== 'result')
    throw new Error('Fixture commit failed: ' + JSON.stringify(committed))
  expect(committed.state).toBe('local-committed')
  return { prepare, prepared, commit, committed }
}
async function confirm(
  w: ReturnType<typeof world>,
  applied: Awaited<ReturnType<typeof apply>>,
  revision = 1,
) {
  return w.engine.confirmInventory({
    ack: {
      operation_id: applied.prepare.operation_id,
      local_committed_receipt_sha256: await configurationReceiptHash(
        applied.committed.receipt,
      ),
      committed_revision: revision,
    },
    attestation: 'fixture-attestation',
    context: w.context('status'),
  })
}

describe('Bambu Lab signed onboarding contract', () => {
  it('uses the closed bambu-lan target and binds the access code to the signed hash', async () => {
    const input = target({ control: true })
    expect(input).toEqual({
      v: 1,
      protocol: 'config-v1',
      backend: 'bambu',
      model: { family: 'bambu-lan', provisional: true },
      ipv4: '192.168.1.60',
      serial: SERIAL,
      access_code: CODE,
      control: true,
    })
    expect(target().control).toBe(false)
    expect(
      decodeConfigurationRequest(
        encodeConfigurationRequest(prepareFrame(input)),
      ),
    ).toMatchObject({ target: input })
    const hash = await configurationTargetHash(input)
    for (const other of [
      target({ control: true, accessCode: 'AnotherC0de' }),
      target({ control: false }),
      target({ control: true, ipv4: '192.168.1.61' }),
      target({ control: true, serial: '01S00C123456780' }),
    ])
      expect(await configurationTargetHash(other)).not.toBe(hash)
    for (const extra of [
      { password: 'secret' },
      { port: 8883 },
      { host: 'printer.local' },
      { endpoint: { ipv4: '192.168.1.60', port: 8883 } },
      { backend: 'other' },
      { model: { family: 'bambu-lan', provisional: false } },
      { model: { family: 'bambu-x1c', provisional: true } },
      { control: 'yes' },
    ])
      expect(
        ConfigurationTarget.safeParse({ ...input, ...extra }).success,
      ).toBe(false)
  })
  it('never shows the access code in a browser DTO', () => {
    const input = target({ control: true })
    const safe = withoutBambuAccessCode(input)
    expect(safe).not.toHaveProperty('access_code')
    expect(BambuConfigurationTarget.safeParse(safe).success).toBe(true)
    const dto = describeBambuTarget(input)
    expect(dto.accessCode).toBe('configurado')
    expect(dto.support).toBe('unqualified')
    expect(JSON.stringify([safe, dto])).not.toContain(CODE)
    expect(BAMBU_LAN_COMMAND_NOTE).toMatch(/Somente LAN/)
    expect(BAMBU_LAN_COMMAND_NOTE).toMatch(/Modo desenvolvedor/)
  })
})

describe('Bambu Lab form validation', () => {
  it.each([
    '',
    'printer.local',
    'bambu',
    'http://192.168.1.60',
    '192.168.1.60:8883',
    '192.168.1.60/',
    '192.168.01.60',
    '192.168.1',
    '192.168.1.256',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    ' 192.168.1.60',
    '192.168.1.60\n',
    '::1',
    'fe80::1',
  ])('rejects address %j without echoing any input', (ipv4) => {
    const result = validateBambuTargetInput({
      ipv4,
      serial: SERIAL,
      accessCode: CODE,
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(CODE)
    expect(JSON.stringify(result)).not.toContain(SERIAL)
    if (!result.ok) expect(result.error).toMatch(/IPv4/)
  })
  it.each([
    '',
    '01s00c123456789',
    '01S00C12',
    '0'.repeat(21),
    '01S00C-23456789',
    '01S00C 123456789',
    '01S00C123456789\n',
    '../01S00C1234567',
    'device/+/report',
    '01S00C12345678#',
  ])('rejects serial %j', (serial) => {
    const result = validateBambuTargetInput({
      ipv4: '192.168.1.60',
      serial,
      accessCode: CODE,
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(CODE)
    if (!result.ok) expect(result.error).toMatch(/série/)
  })
  it('rejects invalid access codes and labels without reflecting them', () => {
    for (const accessCode of [
      '',
      'short',
      'x'.repeat(33),
      'secret code',
      'secret\r\ncode',
      'código-secreto',
    ]) {
      const result = validateBambuTargetInput({
        ipv4: '192.168.1.60',
        serial: SERIAL,
        accessCode,
      })
      expect(result.ok).toBe(false)
      if (accessCode.length > 4)
        expect(JSON.stringify(result)).not.toContain(accessCode)
    }
    expect(
      validateBambuTargetInput({
        ipv4: '192.168.1.60',
        serial: SERIAL,
        accessCode: CODE,
        displayLabel: '\nprivate\x00',
      }).ok,
    ).toBe(false)
    expect(
      validateBambuTargetInput({
        ipv4: '192.168.1.60',
        serial: SERIAL,
        accessCode: CODE,
        displayLabel: '  X1C da bancada  ',
      }),
    ).toMatchObject({ ok: true, displayLabel: 'X1C da bancada' })
  })
})

describe('Bambu Lab Connector apply', () => {
  it('probes read-only, writes the private binding and replays idempotently', async () => {
    const w = world()
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const input = target({ control: true })
    const applied = await apply(w, input)
    expect(w.probes).toHaveLength(1)
    expect(w.probes[0]).toMatchObject({
      host: '192.168.1.60',
      port: 8883,
      serial: SERIAL,
    })
    expect(w.probedCodes).toEqual([CODE])
    const identity = bambuIdentity(SERIAL)
    expect(applied.committed.receipt.observed).toMatchObject({
      device_id: identity.device_id,
      support: 'unqualified',
    })
    expect(applied.committed.receipt.target.bridge_instance_id).toBe(
      identity.bridge_instance_id,
    )
    expect(identity.device_id).not.toContain(SERIAL)
    // A second prepare for the same serial waits for inventory confirmation.
    expect(await w.send(prepareFrame(input, 1))).toMatchObject({
      type: 'error',
      code: 'busy',
    })
    expect(statSync(w.bindingsPath).mode & 0o777).toBe(0o600)
    const rawBindings = readFileSync(w.bindingsPath, 'utf8')
    const loaded = parseBambuOnboardedConfig(JSON.parse(rawBindings), w.scope)
    expect(loaded.printers).toHaveLength(1)
    expect(loaded.assignments).toHaveLength(1)
    const printer = loaded.printers[0]!
    expect(printer).toMatchObject({
      serial: SERIAL,
      host: '192.168.1.60',
      port: 8883,
      control: true,
      pinSha256: PIN,
    })
    expect(loaded.assignments[0]).toMatchObject({
      printer_key: printer.printerKey,
      farm_id: w.scope.farm_id,
      agent_id: w.scope.agent_id,
    })
    expect(statSync(printer.credentialFile).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(printer.credentialFile, 'utf8'))).toEqual({
      accessCode: CODE,
    })
    // The binding is exactly what the existing Bambu runtime consumes.
    expect(readBambuCredentials(printer)).toEqual({
      username: 'bblp',
      password: CODE,
    })
    expect(
      readBambuPrinterBinding(
        provisionBambuPrinter(loaded.assignments[0], {
          ...printer,
          allowedEndpoints: [{ host: printer.host, port: printer.port }],
        }),
      )?.control,
    ).toBe(true)
    // The accepted runtime file is never created or edited by Bambu onboarding.
    expect(existsSync(w.scope.runtimeConfigPath)).toBe(false)
    expect(w.credentials()).toHaveLength(1)
    expect((await w.engine.unconfirmedAssignmentIds()).size).toBe(1)
    expect(
      (
        await w.engine.confirmInventory({
          ack: {
            operation_id: applied.prepare.operation_id,
            local_committed_receipt_sha256: await configurationReceiptHash(
              applied.committed.receipt,
            ),
            committed_revision: 1,
          },
          attestation: 'wrong',
          context: w.context('status'),
        })
      ).ok,
    ).toBe(false)
    expect((await confirm(w, applied)).ok).toBe(true)
    expect(await w.engine.unconfirmedAssignmentIds()).toEqual(new Set())
    // Replayed commit frame: same answer, no second binding.
    expect(
      (await w.send({ ...applied.commit, request_id: randomUUID() })).type,
    ).toBe('result')
    expect(readFileSync(w.bindingsPath, 'utf8')).toBe(rawBindings)
    // A whole new operation for the same printer converges on the same binding.
    const twice = await apply(w, target({ control: true }), 1)
    expect(twice.committed.receipt.target.device_id).toBe(
      applied.committed.receipt.target.device_id,
    )
    expect(readFileSync(w.bindingsPath, 'utf8')).toBe(rawBindings)
    expect(w.credentials()).toHaveLength(1)
    const wire = [
      encodeConfigurationResponse(applied.prepared),
      encodeConfigurationResponse(applied.committed),
      encodeConfigurationResponse(twice.committed),
      JSON.stringify(w.diagnostics),
      JSON.stringify(w.acknowledgements),
      JSON.stringify(log.mock.calls),
      JSON.stringify(error.mock.calls),
      rawBindings,
    ].join('\n')
    expect(wire).not.toContain(CODE)
    for (const file of readdirSync(join(w.dir, 'state', 'operations')))
      expect(
        readFileSync(join(w.dir, 'state', 'operations', file), 'utf8'),
      ).not.toContain(CODE)
    expect(
      readFileSync(join(w.dir, 'state', 'state.json'), 'utf8'),
    ).not.toContain(CODE)
  })
  it('keeps telemetry-only as the default when control is not opted in', async () => {
    const w = world()
    await apply(w, target())
    const loaded = parseBambuOnboardedConfig(
      JSON.parse(readFileSync(w.bindingsPath, 'utf8')),
      w.scope,
    )
    expect(loaded.printers[0]!.control).toBe(false)
  })
  it('rejects an unreachable printer or refused code without keeping the credential', async () => {
    const w = world({ reachable: false })
    const result = await w.send(prepareFrame(target()))
    expect(result).toMatchObject({ type: 'error', code: 'not-available' })
    expect(JSON.stringify(result)).not.toContain(CODE)
    expect(describeBambuConfigurationError('not-available')).toBeTruthy()
    expect(await w.engine.pendingInventoryConfirmations()).toEqual([])
    expect(w.credentials()).toEqual([])
    expect(existsSync(w.bindingsPath)).toBe(false)
  })
  it('refuses addresses outside the Connector printer networks before any probe', async () => {
    const w = world()
    for (const ipv4 of ['10.0.0.5', '127.0.0.1', '8.8.8.8', '192.168.1.255'])
      expect(await w.send(prepareFrame(target({ ipv4 })))).toMatchObject({
        type: 'error',
        code: 'invalid-request',
      })
    expect(
      await w.send(prepareFrame(withoutBambuAccessCode(target()))),
    ).toMatchObject({ type: 'error', code: 'invalid-request' })
    expect(w.probes).toEqual([])
    expect(w.credentials()).toEqual([])
  })
  it('cancels a prepared operation without retaining its private credential', async () => {
    const w = world()
    const request = prepareFrame(target())
    expect((await w.send(request)).type).toBe('result')
    expect(w.credentials()).toHaveLength(2)
    expect(
      await w.send({
        v: 1,
        protocol: 'config-v1',
        type: 'cancel',
        request_id: randomUUID(),
        operation_id: request.operation_id,
        expected_revision: 0,
        target_sha256: await configurationTargetHash(request.target),
      }),
    ).toMatchObject({ type: 'unknown', reason: 'cancel-acknowledged' })
    expect(w.credentials()).toEqual([])
    expect(existsSync(w.bindingsPath)).toBe(false)
  })
  it('refuses a changed code, control flag or address on an existing printer and revoked authority', async () => {
    const w = world()
    const first = await apply(w, target())
    expect((await confirm(w, first)).ok).toBe(true)
    const before = readFileSync(w.bindingsPath, 'utf8')
    for (const changed of [
      target({ accessCode: 'OtherC0de123' }),
      target({ control: true }),
      target({ ipv4: '192.168.1.61' }),
      target({ serial: '01S00C999999999' }),
    ]) {
      const prepared = await w.send(prepareFrame(changed, 1))
      if (prepared.type !== 'result')
        throw new Error('Fixture prepare failed: ' + JSON.stringify(prepared))
      const cancel = {
        v: 1,
        protocol: 'config-v1',
        type: 'cancel',
        request_id: randomUUID(),
        operation_id: prepared.operation_id,
        expected_revision: 1,
        target_sha256: prepared.receipt.target.target_sha256,
      } as const
      expect(
        await w.send({
          ...cancel,
          request_id: randomUUID(),
          type: 'commit',
          prepared_receipt_sha256: await configurationReceiptHash(
            prepared.receipt,
          ),
        }),
      ).toMatchObject({ type: 'error', code: 'identity-conflict' })
      expect(await w.send(cancel)).toMatchObject({
        type: 'unknown',
        reason: 'cancel-acknowledged',
      })
    }
    expect(readFileSync(w.bindingsPath, 'utf8')).toBe(before)
    expect(w.credentials()).toHaveLength(1)
    w.revoke()
    const probes = w.probes.length
    expect(await w.send(prepareFrame(target(), 1))).toMatchObject({
      type: 'error',
      code: 'capability-rejected',
    })
    expect(w.probes).toHaveLength(probes)
  })
  it('rejects tampered or foreign private bindings', async () => {
    const w = world()
    await apply(w, target())
    const stored = JSON.parse(readFileSync(w.bindingsPath, 'utf8'))
    const other = { ...w.scope, farm_id: randomUUID() }
    expect(() => parseBambuOnboardedConfig(stored, other)).toThrow()
    for (const tampered of [
      { ...stored, assignments: [] },
      { ...stored, printers: [{ ...stored.printers[0], host: '8.8.8.8' }] },
      {
        ...stored,
        printers: [{ ...stored.printers[0], accessCode: CODE }],
      },
      {
        ...stored,
        printers: [
          (({ pinSha256: _pin, ...rest }) => rest)(stored.printers[0]),
        ],
      },
    ])
      expect(() => parseBambuOnboardedConfig(tampered, w.scope)).toThrow()
  })
  it('default probe fails closed against a loopback port that is not a printer', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bambu-probe-')))
    directories.push(dir)
    const credentialFile = join(dir, 'credential.json')
    writeFileSync(credentialFile, JSON.stringify({ accessCode: CODE }), {
      mode: 0o600,
    })
    const server = createServer((socket) => socket.destroy())
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    try {
      expect(
        await probeBambuLan({
          host: '127.0.0.1',
          port: address.port,
          serial: SERIAL,
          credentialFile,
          signal: new AbortController().signal,
        }),
      ).toEqual({ ok: false })
    } finally {
      await new Promise((done) => server.close(done))
    }
  })
})

describe('Bambu Lab form dispatch', () => {
  it('sends the access code only to the signed channel and persists a redacted recovery context', async () => {
    const require = createRequire(resolve('apps/farm/package.json'))
    const { parse, compileScript } = require('vue/compiler-sfc')
    const source = readFileSync('apps/farm/app/pages/impressoras.vue', 'utf8')
    expect(source).toContain('BAMBU_LAN_COMMAND_NOTE')
    expect(source).toContain('<option value="bambu-lan">')
    const { descriptor } = parse(source)
    const compiled = compileScript(descriptor, { id: 'bambu-presend' })
    const node = compiled.scriptSetupAst.find(
      (item: { type: string; id?: { name: string } }) =>
        item.type === 'FunctionDeclaration' &&
        item.id?.name === 'prepareBambuPrinter',
    )
    const javascript = transformSync(
      descriptor.scriptSetup.content.slice(node.start, node.end),
      { loader: 'ts', target: 'es2022' },
    ).code
    const ref = <T>(value: T) => ({ value })
    const persisted: string[] = []
    const sent: unknown[] = []
    const context = {
      kobraBusy: ref(false),
      kobraBootstrap: ref({
        kind: 'ready',
        data: { bootstrap: { revision: 0 } },
      }),
      kobraError: ref(''),
      kobraStatus: ref(''),
      bambuIp: ref(' 192.168.1.60 '),
      bambuSerial: ref(SERIAL),
      bambuAccessCode: ref(CODE),
      bambuControl: ref(true),
      kobraLabel: ref('X1C'),
      kobraGeneration: 1,
      kobraController: null,
      kobraStage: ref('idle'),
      kobraKeyState: ref({ kind: 'available', accountId: 'admin' }),
      farmId: ref(randomUUID()),
      kobraAgentId: ref(randomUUID()),
      kobraKeyId: ref(randomUUID()),
      kobraOperation: ref<unknown>(null),
      validateBambuTargetInput,
      withoutBambuAccessCode,
      configurationTargetHash,
      crypto,
      AbortController,
      persistPendingOperation: (value: unknown) => {
        persisted.push(JSON.stringify(value))
      },
      ensureKobraSession: async () => ({
        async prepare(input: { target: unknown; beforeDispatch: () => void }) {
          sent.push(input.target)
          input.beforeDispatch()
          return { kind: 'prepared' }
        },
      }),
      applySessionOutcome: vi.fn(),
      handleKobraException: vi.fn(),
      nextTick: async () => {},
      kobraErrorSummary: ref(null),
    }
    const prepare = new Function(
      'context',
      `with (context) { ${javascript}; return prepareBambuPrinter }`,
    )(context)
    await prepare()
    expect(context.handleKobraException).not.toHaveBeenCalled()
    expect(sent).toEqual([target({ control: true })])
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).not.toContain(CODE)
    expect(JSON.stringify(context.kobraOperation.value)).not.toContain(CODE)
    expect(context.bambuAccessCode.value).toBe('')
    expect(context.applySessionOutcome).toHaveBeenCalledOnce()
  })
})
