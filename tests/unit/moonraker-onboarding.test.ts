import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { transformSync } from 'esbuild'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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
import { moonrakerIdentity } from '../../packages/connector/src/provisioning/moonraker.ts'
import { configurationOpaqueId } from '../../packages/farm-protocol/src/configuration-common.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { createProvisioningEngine } from '../../packages/connector/src/provisioning/engine.ts'
import {
  trustProvisioningAuthority,
  type ProvisioningContext,
} from '../../packages/connector/src/provisioning/authority.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { collectableRuntime } from '../../packages/connector/src/runtime/configuration-snapshot.ts'
import { createRuntimeActivator } from '../../packages/connector/src/runtime/configuration-activation.ts'
import {
  validateMoonrakerTargetInput,
  withoutMoonrakerKey,
  describeMoonrakerConfigurationError,
} from '../../apps/farm/app/utils/moonraker-onboarding.ts'
import { MoonrakerConfigurationRegistrationResponseDto } from '../../apps/farm/app/utils/moonraker-onboarding-session.ts'
import { serveWsTestServer } from './ws-serve.ts'

// The fixture is a loopback WebSocket peer. Printer-network policy (#593)
// refuses that address. Admit only the fixture address here; every other
// address still goes through the real policy.
vi.mock('../../packages/connector/src/provisioning/policy.ts', async (load) => {
  const actual =
    await load<
      typeof import('../../packages/connector/src/provisioning/policy.ts')
    >()
  return {
    ...actual,
    createPrinterNetworkPolicy: (cidrs: readonly string[]) => {
      const real = actual.createPrinterNetworkPolicy(cidrs)
      return { allows: (ip: string) => ip === '127.0.0.1' || real.allows(ip) }
    },
  }
})

const directories: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function target(origin = 'http://192.168.1.50:7125', apiKey?: string) {
  const value = validateMoonrakerTargetInput({
    origin,
    ...(apiKey ? { apiKey } : {}),
  })
  if (!value.ok) throw new Error(value.error)
  return value.target
}
async function fixture(
  options: { key?: string; ready?: boolean; malformed?: boolean } = {},
) {
  const methods: string[] = []
  const headers: string[] = []
  const server = await serveWsTestServer({
    http: () => new Response('fixture', { status: 404 }),
    upgrade(request) {
      headers.push(request.headers.get('x-api-key') ?? '')
      return (
        new URL(request.url).pathname === '/websocket' &&
        (!options.key || request.headers.get('x-api-key') === options.key)
      )
    },
    onMessage(socket, message) {
      const rpc = JSON.parse(message)
      methods.push(rpc.method)
      if (options.malformed) return socket.send('{invalid')
      const result =
        rpc.method === 'server.connection.identify'
          ? { connection_id: 1 }
          : rpc.method === 'server.info'
            ? {
                klippy_connected: options.ready !== false,
                klippy_state: options.ready === false ? 'startup' : 'ready',
              }
            : rpc.method === 'printer.objects.list'
              ? { objects: ['extruder'] }
              : rpc.method === 'printer.objects.query'
                ? {
                    status: {
                      toolhead: { extruder: 'extruder' },
                      extruder: { temperature: 22, target: 0 },
                    },
                  }
                : { webcams: [] }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    },
  })
  cleanups.push(server.stop)
  return { origin: `http://127.0.0.1:${server.port}`, methods, headers }
}
function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moonraker-onboarding-')))
  directories.push(dir)
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const signer = identity.configurationReceiptSigner()
  const scope = {
    runtimeConfigPath: join(dir, 'runtime.json'),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    bootstrap: {
      telemetry: {
        endpoint: 'https://farm.example/api/connector/telemetry',
        audience: 'open3dfarm/connector',
      },
    },
  }
  let current = true
  const diagnostics: unknown[] = []
  const acknowledgements: unknown[] = []
  const engine = createProvisioningEngine({
    stateDirectory: join(dir, 'state'),
    runtime: scope,
    connector: signer,
    managedBridge: null,
    printerNetworks: ['192.168.1.0/24'],
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
  function context(action: ProvisioningContext['action']): ProvisioningContext {
    return {
      ...binding,
      action,
      capability_id: randomUUID(),
      admission_nonce: 'A'.repeat(43),
    }
  }
  const send = (frame: ConfigurationRequestFrame) =>
    engine.handle({ frame, context: context(frame.type) })
  return {
    dir,
    engine,
    scope,
    send,
    context,
    diagnostics,
    acknowledgements,
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
  expect(prepared.type).toBe('result')
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
  expect(committed.type).toBe('result')
  if (committed.type !== 'result')
    throw new Error('Fixture commit failed: ' + JSON.stringify(committed))
  expect(committed.state).toBe('local-committed')
  return { prepare, prepared, commit, committed }
}

describe('Moonraker signed onboarding', () => {
  it('preserves valid identities and fixes non-alphanumeric digest prefixes', () => {
    for (const [origin, expected] of [
      ['http://127.0.0.1:7125', 'Uv7anHdw_zlIK7jGMdYQgh8P0YfhGemDpZxw1vvXM3g'],
      ['http://127.0.0.1:1069', 'm_o6e44RElczUdMuenccOLYNObiLUzrHPqR2v_sbPRw8'],
      ['http://127.0.0.1:1162', 'm-FSTvIXZ5yCbYwEBeqKWKH9c4BAqGUo9HW9rspBeur0'],
    ]) {
      const identity = moonrakerIdentity(origin!)
      expect(identity.device_id).toBe(expected)
      expect(configurationOpaqueId.safeParse(identity.device_id).success).toBe(
        true,
      )
    }
  })
  it('validates the closed contract and binds the key to the signed target hash', async () => {
    const input = target('https://printer.local:7125/', 'synthetic_key')
    expect(input).toMatchObject({
      backend: 'moonraker',
      origin: 'https://printer.local:7125',
      model: { family: 'klipper-moonraker', provisional: true },
    })
    expect(
      decodeConfigurationRequest(
        encodeConfigurationRequest(prepareFrame(input)),
      ),
    ).toMatchObject({ target: input })
    expect(await configurationTargetHash(input)).not.toBe(
      await configurationTargetHash(target(input.origin)),
    )
    for (const extra of [
      { password: 'secret' },
      { headers: {} },
      { backend: 'other' },
      { model: { family: 'klipper-moonraker', provisional: false } },
    ])
      expect(
        ConfigurationTarget.safeParse({ ...input, ...extra }).success,
      ).toBe(false)
    expect(withoutMoonrakerKey(input)).not.toHaveProperty('api_key')
  })
  it.each([
    '',
    'ftp://printer.local',
    'http://u:p@printer.local',
    'http://printer.local/path',
    'http://printer.local?key=secret',
    'http://printer.local#fragment',
    'http://printer.local?',
    'http://printer.local#',
    ' http://printer.local',
    'http://printer.local\n',
    'http://printer.local\\path',
    'http://printer.local/%2e%2e',
    'http://printer.local//',
    'http://printer.local:bad',
    'http://printer.local/../',
    'http://@printer.local',
  ])('rejects invalid origin %j without echoing it', (origin) => {
    const result = validateMoonrakerTargetInput({
      origin,
      apiKey: 'private_key',
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private_key')
  })
  it('rejects invalid keys and labels without reflecting them', () => {
    for (const apiKey of ['x'.repeat(257), 'secret\r\nheader', 'secret key'])
      expect(
        validateMoonrakerTargetInput({ origin: 'http://printer.local', apiKey })
          .ok,
      ).toBe(false)
    expect(
      validateMoonrakerTargetInput({
        origin: 'http://printer.local',
        displayLabel: '\nprivate\x00',
      }).ok,
    ).toBe(false)
  })
  it('probes read-only, persists privately, confirms inventory, activates collection and replays idempotently', async () => {
    const peer = await fixture({ key: 'synthetic_key' })
    const w = world()
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const applied = await apply(w, target(peer.origin, 'synthetic_key'))
    expect(peer.methods).toEqual([
      'server.connection.identify',
      'server.info',
      'printer.objects.list',
      'printer.objects.query',
      'server.webcams.list',
    ])
    expect(peer.headers).toEqual(['synthetic_key'])
    expect(applied.committed.receipt.observed.support).toBe('unqualified')
    expect(
      await w.send(prepareFrame(target(peer.origin, 'synthetic_key'), 1)),
    ).toMatchObject({ type: 'error', code: 'busy' })
    const loaded = readAgentRuntimeConfig(w.scope.runtimeConfigPath, w.scope)
    expect(loaded.collection.printers).toHaveLength(1)
    expect(loaded.assignments).toHaveLength(1)
    const printer = loaded.collection.printers[0]!
    expect(printer.origin).toBe(peer.origin)
    expect(printer.apiKeyFile).toBeDefined()
    expect(statSync(printer.apiKeyFile!).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(printer.apiKeyFile!, 'utf8'))).toEqual({
      origin: peer.origin,
      apiKey: 'synthetic_key',
    })
    const rawRuntime = JSON.parse(
      readFileSync(w.scope.runtimeConfigPath, 'utf8'),
    )
    const pending = await w.engine.unconfirmedAssignmentIds()
    expect(pending.size).toBe(1)
    expect(collectableRuntime(rawRuntime, pending)).toBeNull()
    const starts: string[] = []
    const activator = createRuntimeActivator({
      runtimeConfigPath: w.scope.runtimeConfigPath,
      scope: w.scope,
      snapshotPath: join(w.dir, 'snapshot.json'),
      start: async (signal, path) => {
        starts.push(path)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      },
    })
    cleanups.push(activator.stop)
    expect(await activator.reload(pending)).toBe('unconfirmed')
    expect(starts).toHaveLength(0)
    const confirmation = {
      ack: {
        operation_id: applied.prepare.operation_id,
        local_committed_receipt_sha256: await configurationReceiptHash(
          applied.committed.receipt,
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
      await activator.reload(await w.engine.unconfirmedAssignmentIds()),
    ).toBe('activated')
    expect(starts).toHaveLength(1)
    expect(
      (await w.send({ ...applied.commit, request_id: randomUUID() })).type,
    ).toBe('result')
    expect(
      readAgentRuntimeConfig(w.scope.runtimeConfigPath, w.scope).collection
        .printers,
    ).toHaveLength(1)
    const wire = [
      encodeConfigurationResponse(applied.prepared),
      encodeConfigurationResponse(applied.committed),
      JSON.stringify(w.diagnostics),
      JSON.stringify(w.acknowledgements),
      JSON.stringify(log.mock.calls),
      JSON.stringify(error.mock.calls),
      JSON.stringify(rawRuntime),
    ].join('\n')
    expect(wire).not.toContain('synthetic_key')
    for (const file of readdirSync(join(w.dir, 'state', 'operations')))
      expect(
        readFileSync(join(w.dir, 'state', 'operations', file), 'utf8'),
      ).not.toContain('synthetic_key')
    const twice = await apply(w, target(peer.origin + '/', 'synthetic_key'), 1)
    expect(twice.committed.receipt.target.device_id).toBe(
      applied.committed.receipt.target.device_id,
    )
    expect(readFileSync(w.scope.runtimeConfigPath, 'utf8')).toBe(
      JSON.stringify(rawRuntime),
    )
    expect(
      MoonrakerConfigurationRegistrationResponseDto.safeParse({
        assignmentId: loaded.assignments[0]!.assignment_id,
        printerKey: printer.printerKey,
        receiptSha256: 'A'.repeat(43),
        status: 'active',
        replayed: true,
        inventoryAckWire: 'fixture',
      }).success,
    ).toBe(true)
  })
  it.each([
    { ready: false, code: 'moonraker-not-ready' },
    { malformed: true, code: 'moonraker-invalid-response' },
    { key: 'required_key', code: 'moonraker-unavailable' },
  ])(
    'maps read-only probe failure to $code without accepting configuration',
    async (input) => {
      const peer = await fixture(input)
      const w = world()
      const result = await w.send(prepareFrame(target(peer.origin)))
      expect(result).toMatchObject({ type: 'error', code: input.code })
      expect(describeMoonrakerConfigurationError(input.code)).toBeTruthy()
      expect(await w.engine.pendingInventoryConfirmations()).toEqual([])
      expect(readdirSync(join(w.dir, 'state', 'credentials'))).toEqual([])
      expect(
        peer.methods.every((method) =>
          ['server.connection.identify', 'server.info'].includes(method),
        ),
      ).toBe(true)
    },
  )
  it('preserves existing collection while a new Moonraker assignment awaits inventory', async () => {
    const peer = await fixture()
    const w = world()
    const prior = {
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: ['http://127.0.0.1:1'],
        printers: [{ printerKey: 'existing', origin: 'http://127.0.0.1:1' }],
      },
      assignments: [
        {
          assignment_id: randomUUID(),
          farm_id: w.scope.farm_id,
          agent_id: w.scope.agent_id,
          printer_key: 'existing',
          moonraker_origin: 'http://127.0.0.1:1',
        },
      ],
      ...w.scope.bootstrap,
    }
    writeFileSync(w.scope.runtimeConfigPath, JSON.stringify(prior), {
      mode: 0o600,
    })
    await apply(w, target(peer.origin))
    const current = JSON.parse(readFileSync(w.scope.runtimeConfigPath, 'utf8'))
    const snapshot = collectableRuntime(
      current,
      await w.engine.unconfirmedAssignmentIds(),
    )
    expect(snapshot).toEqual({
      ...prior,
      collection: {
        ...prior.collection,
        allowedOrigins: [...prior.collection.allowedOrigins, peer.origin],
      },
    })
    expect(snapshot?.assignments).toHaveLength(1)
    const collection = snapshot?.collection as { printers: unknown[] }
    expect(collection.printers).toEqual(prior.collection.printers)
    expect(
      readAgentRuntimeConfig(w.scope.runtimeConfigPath, w.scope).collection
        .printers,
    ).toHaveLength(2)
  })
  it('cancels a prepared operation without retaining its private credential', async () => {
    const peer = await fixture({ key: 'synthetic_key' })
    const w = world()
    const request = prepareFrame(target(peer.origin, 'synthetic_key'))
    expect((await w.send(request)).type).toBe('result')
    expect(readdirSync(join(w.dir, 'state', 'credentials'))).toHaveLength(1)
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
    expect(readdirSync(join(w.dir, 'state', 'credentials'))).toEqual([])
    expect(await w.engine.pendingInventoryConfirmations()).toEqual([])
  })
  it('refuses revoked authority before network and refuses changing keys on an existing origin', async () => {
    const peer = await fixture()
    const w = world()
    const first = await apply(w, target(peer.origin, 'first_key'))
    expect(
      (
        await w.engine.confirmInventory({
          ack: {
            operation_id: first.prepare.operation_id,
            local_committed_receipt_sha256: await configurationReceiptHash(
              first.committed.receipt,
            ),
            committed_revision: 1,
          },
          attestation: 'fixture-attestation',
          context: w.context('status'),
        })
      ).ok,
    ).toBe(true)
    const prepared = await w.send(
      prepareFrame(target(peer.origin, 'other_key'), 1),
    )
    if (prepared.type !== 'result') throw new Error('Fixture prepare failed')
    expect(
      await w.send({
        v: 1,
        protocol: 'config-v1',
        type: 'commit',
        request_id: randomUUID(),
        operation_id: prepared.operation_id,
        expected_revision: 1,
        target_sha256: prepared.receipt.target.target_sha256,
        prepared_receipt_sha256: await configurationReceiptHash(
          prepared.receipt,
        ),
      }),
    ).toMatchObject({ type: 'error', code: 'identity-conflict' })
    w.revoke()
    const before = peer.methods.length
    expect(await w.send(prepareFrame(target(peer.origin), 1))).toMatchObject({
      type: 'error',
      code: 'capability-rejected',
    })
    expect(peer.methods).toHaveLength(before)
  })
})

describe('Moonraker form dispatch', () => {
  it('sends the key only to the signed channel and persists a redacted recovery context', async () => {
    const require = createRequire(resolve('apps/farm/package.json'))
    const { parse, compileScript } = require('vue/compiler-sfc')
    const { descriptor } = parse(
      readFileSync('apps/farm/app/pages/impressoras.vue', 'utf8'),
    )
    const compiled = compileScript(descriptor, { id: 'moonraker-presend' })
    const node = compiled.scriptSetupAst.find(
      (item: { type: string; id?: { name: string } }) =>
        item.type === 'FunctionDeclaration' &&
        item.id?.name === 'prepareMoonrakerPrinter',
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
      moonrakerOrigin: ref('http://printer.local:7125'),
      moonrakerApiKey: ref('private_key'),
      kobraLabel: ref('Voron'),
      kobraGeneration: 1,
      kobraController: null,
      kobraStage: ref('idle'),
      kobraKeyState: ref({ kind: 'available', accountId: 'admin' }),
      farmId: ref(randomUUID()),
      kobraAgentId: ref(randomUUID()),
      kobraKeyId: ref(randomUUID()),
      kobraOperation: ref<unknown>(null),
      validateMoonrakerTargetInput,
      withoutMoonrakerKey,
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
      `with (context) { ${javascript}; return prepareMoonrakerPrinter }`,
    )(context)
    await prepare()
    expect(sent).toEqual([target(context.moonrakerOrigin.value, 'private_key')])
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).not.toContain('private_key')
    expect(JSON.stringify(context.kobraOperation.value)).not.toContain(
      'private_key',
    )
    expect(context.moonrakerApiKey.value).toBe('')
    expect(context.handleKobraException).not.toHaveBeenCalled()
    expect(context.applySessionOutcome).toHaveBeenCalledOnce()
  })
})
