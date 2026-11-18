import { createRuntimeActivator } from '../../packages/connector/src/runtime/configuration-activation.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import {
  AnycubicConfigurationTarget,
  ConfigurationTarget,
  configurationTargetHash,
} from '../../packages/farm-protocol/src/configuration-target.ts'
import { configurationReceiptHash } from '../../packages/farm-protocol/src/configuration-receipt.ts'
import {
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
  anycubicIdentity,
  probeAnycubic,
  anycubicCredentialPath,
  type AnycubicProbe,
} from '../../packages/connector/src/provisioning/anycubic.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import {
  validateAnycubicTargetInput,
  describeAnycubicConfigurationError,
  withoutAnycubicCredentials,
  describeAnycubicTarget,
} from '../../apps/farm/app/utils/anycubic-onboarding.ts'

// The provisioning engine fsyncs every durable write. On a disk-backed TMPDIR
// under load those fsyncs alone exceed the default timeout, so fixtures use
// tmpfs when the host has one; durability semantics are unchanged.
const scratchRoot = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()
const directories: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function target(host = '192.168.1.60') {
  const value = validateAnycubicTargetInput({
    host,
    modelId: '20024',
    deviceId: 'device-1',
    username: 'lan-user',
    password: 'private-lan-password',
  })
  if (!value.ok) throw new Error(value.error)
  return value.target
}
function world(reachable = true) {
  const dir = realpathSync(
    mkdtempSync(join(scratchRoot, 'anycubic-onboarding-')),
  )
  directories.push(dir)
  const signer = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  ).configurationReceiptSigner()
  const scope = {
    runtimeConfigPath: join(dir, 'runtime.json'),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    bootstrap: {
      telemetry: {
        endpoint: 'https://farm.example/api/telemetry',
        audience: 'https://farm.example',
      },
    },
  }
  let current = true
  const probes: Parameters<AnycubicProbe>[0][] = []
  const engine = createProvisioningEngine({
    stateDirectory: join(dir, 'state'),
    runtime: scope,
    connector: signer,
    managedBridge: null,
    printerNetworks: ['192.168.1.0/24'],
    anycubicProbe: async (input) => {
      probes.push(input)
      return reachable
    },
    authority: trustProvisioningAuthority({
      async isCurrent(context) {
        return current && context.role === 'admin'
      },
      async acceptsInventoryAck(request) {
        return request.attestation === 'fixture-attestation'
      },
    }),
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
    path: scope.runtimeConfigPath,
    send: (frame: ConfigurationRequestFrame) =>
      engine.handle({ frame, context: context(frame.type) }),
    revoke: () => {
      current = false
    },
  }
}
function prepareFrame(input = target(), revision = 0) {
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
async function apply(w: ReturnType<typeof world>, revision = 0) {
  const prepare = prepareFrame(target(), revision)
  const prepared = await w.send(prepare)
  if (prepared.type !== 'result') throw new Error(JSON.stringify(prepared))
  expect(prepared.state).toBe('prepared')
  const commit = {
    v: 1,
    protocol: 'config-v1',
    type: 'commit',
    request_id: randomUUID(),
    operation_id: prepare.operation_id,
    expected_revision: revision,
    target_sha256: await configurationTargetHash(prepare.target),
    prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
  } as const
  const committed = await w.send(commit)
  if (committed.type !== 'result') throw new Error(JSON.stringify(committed))
  expect(committed.state).toBe('local-committed')
  return { prepare, prepared, commit, committed }
}

describe('Anycubic native onboarding', () => {
  it('accepts the provisional LAN contract and defaults to port 9883', () => {
    expect(ConfigurationTarget.parse(target())).toMatchObject({
      backend: 'anycubic',
      model: { family: 'anycubic-lan', provisional: true },
      port: 9883,
    })
    for (const patch of [
      { port: 0 },
      { port: 65536 },
      { modelId: 'bad/topic' },
      { deviceId: '+' },
      { control: true },
      { passwordFile: '/private/file' },
    ])
      expect(
        AnycubicConfigurationTarget.safeParse({ ...target(), ...patch })
          .success,
      ).toBe(false)
    expect(withoutAnycubicCredentials(target())).not.toHaveProperty('password')
    expect(withoutAnycubicCredentials(target())).not.toHaveProperty('username')
    expect(describeAnycubicTarget(target())).toEqual({
      family: 'Anycubic (LAN)',
      host: '192.168.1.60',
      port: 9883,
      modelId: '20024',
      deviceId: 'device-1',
      credentials: 'configurado',
      support: 'unqualified',
    })
  })
  it.each([
    '',
    'printer.local',
    'http://192.168.1.60',
    '192.168.1.60:9999',
    'user:secret@192.168.1.60',
    '192.168.001.60',
    '224.0.0.1',
    '0.0.0.0',
    '192.168.1.999',
  ])('rejects malformed host %s without echoing it', (host) => {
    expect(
      validateAnycubicTargetInput({
        host,
        modelId: '20024',
        deviceId: 'device-1',
        username: 'lan-user',
        password: 'private-lan-password',
      }).ok,
    ).toBe(false)
  })
  it('validates labels and binds the host to its hash', async () => {
    expect(
      validateAnycubicTargetInput({
        ...target(),
        username: 'lan-user',
        password: 'private-lan-password',
        displayLabel: ' K1 ',
      }),
    ).toMatchObject({ ok: true, displayLabel: 'K1' })
    expect(
      validateAnycubicTargetInput({
        ...target(),
        username: 'lan-user',
        password: 'private-lan-password',
        displayLabel: 'x'.repeat(65),
      }).ok,
    ).toBe(false)
    expect(
      validateAnycubicTargetInput({
        ...target(),
        username: 'lan-user',
        password: 'private-lan-password',
        displayLabel: 'x\x00',
      }).ok,
    ).toBe(false)
    expect(await configurationTargetHash(target())).not.toBe(
      await configurationTargetHash(target('192.168.1.61')),
    )
  })
  it('binds every LAN credential and endpoint field to the signed hash', async () => {
    const original = await configurationTargetHash(target())
    for (const patch of [
      { username: 'other-user' },
      { password: 'other-password' },
      { port: 9884 },
      { modelId: 'other-model' },
      { deviceId: 'other-device' },
    ])
      expect(await configurationTargetHash({ ...target(), ...patch })).not.toBe(
        original,
      )
    expect(
      AnycubicConfigurationTarget.safeParse({
        ...target(),
        password: '\u0001'.repeat(2048),
      }).success,
    ).toBe(false)
  })
  it('applies privately, requires inventory confirmation and replays without duplicates', async () => {
    const w = world()
    const result = await apply(w)
    expect(result.committed.receipt.observed.support).toBe('unqualified')
    expect(result.committed.receipt.observed.device_id).toBe(
      anycubicIdentity(target()).device_id,
    )
    const before = readFileSync(w.path, 'utf8')
    const config = readAgentRuntimeConfig(w.path, w.scope)
    expect(config.collection.version).toBe(5)
    if (config.collection.version !== 5)
      throw Error('Expected Anycubic collection')
    expect(config.collection.anycubic.printers).toEqual([
      {
        printerKey: config.assignments[0]!.printer_key,
        host: '192.168.1.60',
        port: 9883,
        modelId: '20024',
        deviceId: 'device-1',
        username: 'lan-user',
        passwordFile: expect.any(String),
      },
    ])
    expect(config.assignments).toHaveLength(1)
    expect(statSync(w.path).mode & 0o777).toBe(0o600)
    expect(await w.engine.unconfirmedAssignmentIds()).toEqual(
      new Set([config.assignments[0]!.assignment_id]),
    )
    expect(await w.send(prepareFrame(target(), 1))).toMatchObject({
      type: 'error',
      code: 'busy',
    })
    const confirmation = {
      ack: {
        operation_id: result.prepare.operation_id,
        local_committed_receipt_sha256: await configurationReceiptHash(
          result.committed.receipt,
        ),
        committed_revision: 1,
      },
      attestation: 'fixture-attestation',
      context: w.context('status'),
    }
    expect(
      (
        await w.engine.confirmInventory({
          ...confirmation,
          attestation: 'wrong',
        })
      ).ok,
    ).toBe(false)
    expect((await w.engine.confirmInventory(confirmation)).ok).toBe(true)
    expect(await w.engine.unconfirmedAssignmentIds()).toEqual(new Set())
    expect(
      await w.send({ ...result.commit, request_id: randomUUID() }),
    ).toMatchObject({ type: 'result' })
    await apply(w, 1)
    expect(readFileSync(w.path, 'utf8')).toBe(before)
    const binding = config.collection.anycubic.printers[0]!
    expect(JSON.parse(readFileSync(binding.passwordFile, 'utf8'))).toBe(
      'private-lan-password',
    )
    expect(statSync(binding.passwordFile).mode & 0o777).toBe(0o600)
    expect(encodeConfigurationResponse(result.committed)).not.toContain(
      'private-lan-password',
    )
    expect(encodeConfigurationResponse(result.committed)).not.toContain(
      'lan-user',
    )
    expect(encodeConfigurationResponse(result.committed)).not.toContain(w.dir)
    for (const file of readdirSync(join(w.dir, 'state'))) {
      if (!file.endsWith('.json')) continue
      const journal = readFileSync(join(w.dir, 'state', file), 'utf8')
      expect(journal).not.toContain('private-lan-password')
      expect(journal).not.toContain('lan-user')
    }
    expect(
      existsSync(
        anycubicCredentialPath(
          join(w.dir, 'state'),
          result.prepare.operation_id,
        ),
      ),
    ).toBe(false)
    expect(w.probes).toHaveLength(2)
  })
  it('rejects a foreign runtime scope and conflicting credentials', async () => {
    const w = world()
    const result = await apply(w)
    expect(() =>
      readAgentRuntimeConfig(w.path, { ...w.scope, farm_id: randomUUID() }),
    ).toThrow('credential')
    const confirmation = {
      ack: {
        operation_id: result.prepare.operation_id,
        local_committed_receipt_sha256: await configurationReceiptHash(
          result.committed.receipt,
        ),
        committed_revision: 1,
      },
      attestation: 'fixture-attestation',
      context: w.context('status'),
    }
    expect((await w.engine.confirmInventory(confirmation)).ok).toBe(true)
    const prepared = await w.send(
      prepareFrame({ ...target(), password: 'changed-password' }, 1),
    )
    if (prepared.type !== 'result') throw Error('Expected prepared')
    expect(
      await w.send({
        ...result.commit,
        operation_id: prepared.receipt.operation_id,
        request_id: randomUUID(),
        expected_revision: 1,
        target_sha256: await configurationTargetHash({
          ...target(),
          password: 'changed-password',
        }),
        prepared_receipt_sha256: await configurationReceiptHash(
          prepared.receipt,
        ),
      }),
    ).toMatchObject({ type: 'error', code: 'identity-conflict' })
  })
  it('refuses missing LAN credentials before probing', async () => {
    const w = world()
    expect(
      await w.send(prepareFrame(withoutAnycubicCredentials(target()))),
    ).toMatchObject({ type: 'error', code: 'invalid-request' })
    expect(w.probes).toEqual([])
  })
  it('preserves an invalid existing runtime without publishing a password file', async () => {
    const w = world()
    const original = '{"unrelated":"preserve"}'
    writeFileSync(w.path, original, { mode: 0o600 })
    const frame = prepareFrame()
    const prepared = await w.send(frame)
    if (prepared.type !== 'result') throw Error('Expected prepared')
    expect(
      await w.send({
        v: 1,
        protocol: 'config-v1',
        type: 'commit',
        request_id: randomUUID(),
        operation_id: frame.operation_id,
        expected_revision: 0,
        target_sha256: await configurationTargetHash(frame.target),
        prepared_receipt_sha256: await configurationReceiptHash(
          prepared.receipt,
        ),
      }),
    ).toMatchObject({ type: 'error', code: 'identity-conflict' })
    expect(readFileSync(w.path, 'utf8')).toBe(original)
    expect(
      existsSync(
        anycubicCredentialPath(join(w.dir, 'state'), frame.operation_id) +
          '.password.json',
      ),
    ).toBe(false)
  })
  it('checks authority and local network policy before probing', async () => {
    const w = world()
    for (const host of [
      '127.0.0.1',
      '8.8.8.8',
      '192.168.2.60',
      '192.168.1.255',
    ])
      expect(await w.send(prepareFrame(target(host)))).toMatchObject({
        type: 'error',
        code: 'invalid-request',
      })
    expect(w.probes).toHaveLength(0)
    w.revoke()
    expect(await w.send(prepareFrame())).toMatchObject({
      type: 'error',
      code: 'capability-rejected',
    })
    expect(w.probes).toHaveLength(0)
  })
  it('refuses unavailable telemetry and mismatched identity', async () => {
    const w = world(false)
    expect(await w.send(prepareFrame())).toMatchObject({
      type: 'error',
      code: 'not-available',
    })
    expect(describeAnycubicConfigurationError('not-available')).toContain(
      'Anycubic',
    )
    const available = world()
    expect(
      await available.send(prepareFrame({ ...target(), device_id: 'wrong' })),
    ).toMatchObject({ type: 'error', code: 'identity-conflict' })
    expect(await available.engine.pendingInventoryConfirmations()).toEqual([])
  })
  it('cancels a prepared operation without creating a binding', async () => {
    const w = world()
    const request = prepareFrame()
    expect(await w.send(request)).toMatchObject({
      type: 'result',
      state: 'prepared',
    })
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
    expect(await w.engine.pendingInventoryConfirmations()).toEqual([])
    expect(
      existsSync(
        anycubicCredentialPath(join(w.dir, 'state'), request.operation_id),
      ),
    ).toBe(false)
  })
  it('activates only after inventory confirmation and feeds the existing collector with field timing', async () => {
    const w = world()
    const result = await apply(w)
    const observed: Parameters<
      Parameters<typeof createAnycubicCollection>[0]['onObservation']
    >[0][] = []
    const starts: string[] = []
    const activator = createRuntimeActivator({
      runtimeConfigPath: w.path,
      scope: w.scope,
      snapshotPath: join(w.dir, 'snapshot.json'),
      async start(signal, path) {
        starts.push(path)
        const runtime = readAgentRuntimeConfig(path, w.scope)
        if (runtime.collection.version !== 5)
          throw Error('Expected Anycubic runtime')
        const collection = createAnycubicCollection({
          binding: runtime.collection.anycubic.printers[0]!,
          signal,
          onObservation: (value) => observed.push(value),
          onUnavailable() {},
          transport(input) {
            expect(input.credentials).toEqual({
              username: 'lan-user',
              password: 'private-lan-password',
            })
            expect(input.serial).toBe('20024/device-1')
            queueMicrotask(() => {
              input.onReport(
                Buffer.from(
                  JSON.stringify({
                    data: {
                      state: 'printing',
                      progress: 25,
                      curr_nozzle_temp: 200,
                      curr_hotbed_temp: 60,
                    },
                  }),
                ),
              )
              input.onReport(
                Buffer.from(JSON.stringify({ data: { progress: 50 } })),
              )
            })
            return {
              done: new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), {
                  once: true,
                }),
              ),
              async close() {},
            }
          },
        })
        await collection.done
      },
    })
    cleanups.push(() => activator.stop())
    expect(
      await activator.reload(await w.engine.unconfirmedAssignmentIds()),
    ).toBe('unconfirmed')
    expect(starts).toEqual([])
    expect(
      (
        await w.engine.confirmInventory({
          ack: {
            operation_id: result.prepare.operation_id,
            local_committed_receipt_sha256: await configurationReceiptHash(
              result.committed.receipt,
            ),
            committed_revision: 1,
          },
          attestation: 'fixture-attestation',
          context: w.context('status'),
        })
      ).ok,
    ).toBe(true)
    expect(
      await activator.reload(await w.engine.unconfirmedAssignmentIds()),
    ).toBe('activated')
    await new Promise((resolve) => setImmediate(resolve))
    expect(starts).toEqual([join(w.dir, 'snapshot.json')])
    expect(observed).toHaveLength(2)
    expect(observed[0]!.printer).toMatchObject({
      state: 'printing',
      progress: 0.25,
      toolTemperatureCelsius: 200,
      bedTemperatureCelsius: 60,
    })
    expect(observed[1]!.printer.progress).toBe(0.5)
    expect(observed[1]!.fieldObservedAtMonoMs).toMatchObject({
      anycubic: {
        toolTemperatureCelsius: expect.any(Number),
        progress: expect.any(Number),
      },
    })
    expect(observed[0]!.fieldObservedAtMonoMs).toMatchObject({
      anycubic: { toolTemperatureCelsius: expect.any(Number) },
    })
    expect(await activator.reload()).toBe('unchanged')
  })
  it('preserves a pre-existing Moonraker runtime when adding a LAN binding', async () => {
    const w = world()
    const moonraker = {
      printerKey: 'existing',
      origin: 'http://127.0.0.1:7125',
    }
    const assignment = {
      assignment_id: randomUUID(),
      printer_key: 'existing',
      farm_id: w.scope.farm_id,
      agent_id: w.scope.agent_id,
      moonraker_origin: moonraker.origin,
    }
    writeFileSync(
      w.path,
      JSON.stringify({
        ...w.scope.bootstrap,
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: [moonraker.origin],
          printers: [moonraker],
        },
        assignments: [assignment],
      }),
      { mode: 0o600 },
    )
    await apply(w)
    const config = readAgentRuntimeConfig(w.path, w.scope)
    expect(config.collection.printers).toEqual([moonraker])
    expect(config.assignments).toContainEqual(assignment)
    expect(config.telemetry.endpoint).toBe('https://farm.example/api/telemetry')
  })
  it('honors an already aborted probe without opening a socket', async () => {
    expect(
      await probeAnycubic({
        host: '127.0.0.1',
        port: 9883,
        modelId: '20024',
        deviceId: 'device-1',
        credentialFile: '/absent',
        signal: AbortSignal.abort(),
      }),
    ).toBe(false)
  })
})

describe('Anycubic form', () => {
  // Loading vue/compiler-sfc and compiling the full impressoras.vue page is
  // inherently heavy (about 0.5 s idle, several seconds on a loaded CI host),
  // so this test gets an explicit timeout instead of the 5 s default.
  it(
    'dispatches the validated host through the signed session and persists recovery state',
    { timeout: 30_000 },
    async () => {
      const require = createRequire(resolve('apps/farm/package.json'))
      const { parse, compileScript } = require('vue/compiler-sfc')
      const { descriptor } = parse(
        readFileSync('apps/farm/app/pages/impressoras.vue', 'utf8'),
      )
      const compiled = compileScript(descriptor, { id: 'anycubic-form' })
      const node = compiled.scriptSetupAst.find(
        (item: { type: string; id?: { name: string } }) =>
          item.type === 'FunctionDeclaration' &&
          item.id?.name === 'prepareAnycubicPrinter',
      )
      const javascript = transformSync(
        descriptor.scriptSetup.content.slice(node.start, node.end),
        { loader: 'ts', target: 'es2022' },
      ).code
      const ref = <T>(value: T) => ({ value })
      const persisted: unknown[] = []
      const sent: unknown[] = []
      const context = {
        kobraBusy: ref(false),
        kobraBootstrap: ref({
          kind: 'ready',
          data: { bootstrap: { revision: 0 } },
        }),
        kobraError: ref(''),
        kobraStatus: ref(''),
        anycubicHost: ref('192.168.1.60'),
        anycubicPort: ref(9883),
        anycubicModelId: ref('20024'),
        anycubicDeviceId: ref('device-1'),
        anycubicUsername: ref('lan-user'),
        anycubicPassword: ref('private-lan-password'),
        withoutAnycubicCredentials,
        kobraLabel: ref('K1'),
        kobraGeneration: 1,
        kobraController: null,
        kobraStage: ref('idle'),
        kobraKeyState: ref({ kind: 'available', accountId: 'admin' }),
        farmId: ref(randomUUID()),
        kobraAgentId: ref(randomUUID()),
        kobraKeyId: ref(randomUUID()),
        kobraOperation: ref<unknown>(null),
        validateAnycubicTargetInput,
        configurationTargetHash,
        crypto,
        AbortController,
        persistPendingOperation: (input: unknown) => persisted.push(input),
        ensureKobraSession: async () => ({
          async prepare(input: {
            target: unknown
            beforeDispatch: () => void
          }) {
            input.beforeDispatch()
            sent.push(input.target)
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
        `with (context) { ${javascript}; return prepareAnycubicPrinter }`,
      )(context)
      await prepare()
      expect(sent).toEqual([target()])
      expect(persisted).toHaveLength(1)
      expect(JSON.stringify(persisted)).not.toContain('private-lan-password')
      expect(JSON.stringify(persisted)).not.toContain('lan-user')
      expect(context.anycubicPassword.value).toBe('')
      expect(context.anycubicUsername.value).toBe('')
      expect(context.applySessionOutcome).toHaveBeenCalledOnce()
      expect(context.handleKobraException).not.toHaveBeenCalled()
      context.anycubicHost.value = 'http://user:private@host'
      await prepare()
      expect(sent).toHaveLength(1)
      expect(context.kobraError.value).not.toContain('private')
      expect(context.kobraError.value).toContain('IPv4')
    },
  )
})
