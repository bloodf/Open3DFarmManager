import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import {
  CrealityConfigurationTarget,
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
  crealityIdentity,
  probeCreality,
  type CrealityProbe,
} from '../../packages/connector/src/provisioning/creality.ts'
import {
  crealityBindingsPath,
  parseCrealityOnboardedConfig,
} from '../../packages/connector/src/config/creality-onboarding.ts'
import {
  validateCrealityTargetInput,
  describeCrealityConfigurationError,
} from '../../apps/farm/app/utils/creality-onboarding.ts'

const directories: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function target(host = '192.168.1.60') {
  const value = validateCrealityTargetInput({ host })
  if (!value.ok) throw new Error(value.error)
  return value.target
}
function world(reachable = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'creality-onboarding-')))
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
  const probes: Parameters<CrealityProbe>[0][] = []
  const engine = createProvisioningEngine({
    stateDirectory: join(dir, 'state'),
    runtime: scope,
    connector: signer,
    managedBridge: null,
    printerNetworks: ['192.168.1.0/24'],
    crealityProbe: async (input) => {
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
    path: crealityBindingsPath(scope.runtimeConfigPath),
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

describe('Creality native onboarding', () => {
  it('accepts the provisional stock contract and keeps Moonraker separate', () => {
    expect(ConfigurationTarget.parse(target())).toEqual({
      v: 1,
      protocol: 'config-v1',
      backend: 'creality',
      model: { family: 'creality-native', provisional: true },
      host: '192.168.1.60',
    })
    for (const patch of [
      { port: 80 },
      { password: 'secret' },
      { control: true },
      { model: { family: 'klipper-moonraker', provisional: true } },
    ])
      expect(
        CrealityConfigurationTarget.safeParse({ ...target(), ...patch })
          .success,
      ).toBe(false)
    expect(
      ConfigurationTarget.safeParse({
        v: 1,
        protocol: 'config-v1',
        backend: 'moonraker',
        model: { family: 'klipper-moonraker', provisional: true },
        origin: 'http://printer.local:7125',
      }).success,
    ).toBe(true)
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
    expect(validateCrealityTargetInput({ host }).ok).toBe(false)
  })
  it('validates labels and binds the host to its hash', async () => {
    expect(
      validateCrealityTargetInput({
        host: '192.168.1.60',
        displayLabel: ' K1 ',
      }),
    ).toMatchObject({ ok: true, displayLabel: 'K1' })
    expect(
      validateCrealityTargetInput({
        host: '192.168.1.60',
        displayLabel: 'x'.repeat(65),
      }).ok,
    ).toBe(false)
    expect(
      validateCrealityTargetInput({
        host: '192.168.1.60',
        displayLabel: 'x\x00',
      }).ok,
    ).toBe(false)
    expect(await configurationTargetHash(target())).not.toBe(
      await configurationTargetHash(target('192.168.1.61')),
    )
  })
  it('applies privately, requires inventory confirmation and replays without duplicates', async () => {
    const w = world()
    const existingRuntime = '{"unrelated":"preserve"}'
    writeFileSync(w.scope.runtimeConfigPath, existingRuntime, { mode: 0o600 })
    const result = await apply(w)
    expect(result.committed.receipt.observed.support).toBe('unqualified')
    expect(result.committed.receipt.observed.device_id).toBe(
      crealityIdentity(target().host).device_id,
    )
    const before = readFileSync(w.path, 'utf8')
    const config = parseCrealityOnboardedConfig(JSON.parse(before), w.scope)
    expect(config.printers).toEqual([
      {
        printerKey: config.assignments[0]!.printer_key,
        host: '192.168.1.60',
        port: 9999,
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
    expect(readFileSync(w.scope.runtimeConfigPath, 'utf8')).toBe(
      existingRuntime,
    )
    expect(encodeConfigurationResponse(result.committed)).not.toContain(w.dir)
    expect(w.probes).toHaveLength(2)
  })
  it('rejects foreign or ambiguous local mappings', async () => {
    const w = world()
    await apply(w)
    const stored = JSON.parse(readFileSync(w.path, 'utf8'))
    expect(() =>
      parseCrealityOnboardedConfig(stored, {
        ...w.scope,
        farm_id: randomUUID(),
      }),
    ).toThrow('scope')
    expect(() =>
      parseCrealityOnboardedConfig({ ...stored, assignments: [] }, w.scope),
    ).toThrow('scope')
    expect(() =>
      parseCrealityOnboardedConfig(
        { ...stored, printers: [...stored.printers, stored.printers[0]] },
        w.scope,
      ),
    ).toThrow('scope')
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
    expect(describeCrealityConfigurationError('not-available')).toContain(
      'Moonraker',
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
  })
  it('reads loopback stock telemetry without sending any application frame', async () => {
    const require = createRequire(resolve('packages/connector/package.json'))
    const { WebSocketServer } = require('ws')
    const server = new WebSocketServer({ host: '127.0.0.1', port: 9999 })
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate()
          server.close(() => resolve())
        }),
    )
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const messages: unknown[] = []
    let connectionCount = 0
    server.on(
      'connection',
      (socket: {
        on: (event: string, listener: (data: unknown) => void) => void
        send: (data: string) => void
      }) => {
        socket.on('message', (data) => messages.push(data))
        connectionCount += 1
        socket.send('invalid-json')
        socket.send(JSON.stringify({ model: 'K1' }))
        if (connectionCount > 1)
          socket.send(JSON.stringify({ state: 0, printProgress: 0 }))
      },
    )
    expect(
      await probeCreality({
        host: '127.0.0.1',
        signal: AbortSignal.timeout(100),
      }),
    ).toBe(false)
    expect(
      await probeCreality({
        host: '127.0.0.1',
        signal: AbortSignal.timeout(1000),
      }),
    ).toBe(true)
    expect(messages).toEqual([])
  })
  it('honors an already aborted probe without opening a socket', async () => {
    expect(
      await probeCreality({ host: '127.0.0.1', signal: AbortSignal.abort() }),
    ).toBe(false)
  })
})

describe('Creality form', () => {
  it('dispatches the validated host through the signed session and persists recovery state', async () => {
    const require = createRequire(resolve('apps/farm/package.json'))
    const { parse, compileScript } = require('vue/compiler-sfc')
    const { descriptor } = parse(
      readFileSync('apps/farm/app/pages/impressoras.vue', 'utf8'),
    )
    const compiled = compileScript(descriptor, { id: 'creality-form' })
    const routeNode = compiled.scriptSetupAst.find(
      (item: { type: string; id?: { name: string } }) =>
        item.type === 'FunctionDeclaration' &&
        item.id?.name === 'selectCrealityMoonraker',
    )
    const routeJavascript = transformSync(
      descriptor.scriptSetup.content.slice(routeNode.start, routeNode.end),
      { loader: 'ts', target: 'es2022' },
    ).code
    const routeContext = {
      closeKobraSession: vi.fn(),
      onboardingFamily: { value: 'creality-native' },
    }
    new Function(
      'context',
      `with (context) { ${routeJavascript}; selectCrealityMoonraker() }`,
    )(routeContext)
    expect(routeContext.onboardingFamily.value).toBe('klipper-moonraker')
    expect(routeContext.closeKobraSession).toHaveBeenCalledOnce()
    const node = compiled.scriptSetupAst.find(
      (item: { type: string; id?: { name: string } }) =>
        item.type === 'FunctionDeclaration' &&
        item.id?.name === 'prepareCrealityPrinter',
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
      crealityHost: ref('192.168.1.60'),
      kobraLabel: ref('K1'),
      kobraGeneration: 1,
      kobraController: null,
      kobraStage: ref('idle'),
      kobraKeyState: ref({ kind: 'available', accountId: 'admin' }),
      farmId: ref(randomUUID()),
      kobraAgentId: ref(randomUUID()),
      kobraKeyId: ref(randomUUID()),
      kobraOperation: ref<unknown>(null),
      validateCrealityTargetInput,
      configurationTargetHash,
      crypto,
      AbortController,
      persistPendingOperation: (input: unknown) => persisted.push(input),
      ensureKobraSession: async () => ({
        async prepare(input: { target: unknown; beforeDispatch: () => void }) {
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
      `with (context) { ${javascript}; return prepareCrealityPrinter }`,
    )(context)
    await prepare()
    expect(sent).toEqual([target()])
    expect(persisted).toHaveLength(1)
    expect(context.applySessionOutcome).toHaveBeenCalledOnce()
    expect(context.handleKobraException).not.toHaveBeenCalled()
    context.crealityHost.value = 'http://user:private@host'
    await prepare()
    expect(sent).toHaveLength(1)
    expect(context.kobraError.value).not.toContain('private')
    expect(context.kobraError.value).toContain('IPv4')
  })
})
