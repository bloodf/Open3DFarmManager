import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KobraConfigurationTarget,
  KobraXNativeConfigurationTarget,
  type KobraClientCertificateInput,
} from '../../packages/farm-protocol/src/configuration-target.ts'
import type { ConfigurationRequestFrame } from '../../packages/farm-protocol/src/configuration-frames.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  importKobraClientCertFromInput,
  isAllowedKobraInstallPath,
  stageKobraClientCert,
  stagedKobraCertPath,
} from '../../packages/connector/src/config/kobra-x-cert.ts'
import { bundledKobraClientIdentity } from '../../packages/connector/src/config/kobra-x-default-cert.ts'
import { createProvisioningEngine } from '../../packages/connector/src/provisioning/engine.ts'
import {
  trustProvisioningAuthority,
  type ProvisioningContext,
} from '../../packages/connector/src/provisioning/authority.ts'
import type { KobraXProbe } from '../../packages/connector/src/provisioning/kobra-x.ts'

const directories: string[] = []
test.after(() => {
  for (const directory of directories) {
    try {
      chmodSync(directory, 0o700)
    } catch {
      /* ignore */
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  directories.push(dir)
  return dir
}

function createEngineWorld(options: { kobraXProbe?: KobraXProbe } = {}) {
  const dir = makeTempDir('kobra-install-path-engine-')
  const stateDirectory = join(dir, 'state')
  const farm = randomUUID()
  const agent = randomUUID()
  const signer = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  ).configurationReceiptSigner()
  const runtimeConfigPath = join(dir, 'runtime.json')
  writeFileSync(
    runtimeConfigPath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: [],
        printers: [],
      },
      assignments: [],
      telemetry: {
        endpoint: 'https://farm.example/telemetry',
        audience: 'test',
      },
    }),
    { mode: 0o600 },
  )
  const engine = createProvisioningEngine({
    stateDirectory,
    runtime: { runtimeConfigPath, agent_id: agent, farm_id: farm },
    connector: signer,
    managedBridge: {
      origin: 'http://127.0.0.1:7100',
      ownership: 'connector-owned-fresh',
    },
    printerNetworks: ['192.168.1.0/24'],
    ...(options.kobraXProbe ? { kobraXProbe: options.kobraXProbe } : {}),
    authority: trustProvisioningAuthority({
      isCurrent: async (context) => context.role === 'owner',
      acceptsInventoryAck: async () => true,
    }),
  })
  const binding = {
    account_id: 'owner-1',
    role: 'owner' as const,
    farm_id: farm,
    agent_id: agent,
    key_id: randomUUID(),
    credential_jti: randomUUID(),
    transport_id: randomUUID(),
    connector_fingerprint: signer.fingerprint,
  }
  const send = (frame: ConfigurationRequestFrame) =>
    engine.handle({
      frame,
      context: {
        ...binding,
        action: frame.type,
        capability_id: randomUUID(),
        admission_nonce: 'A'.repeat(43),
      } satisfies ProvisioningContext,
    })
  return { dir, stateDirectory, send }
}

function prepareKobraXFrame(
  operationId: string,
  clientCertificate: KobraClientCertificateInput,
): ConfigurationRequestFrame {
  return {
    v: 1,
    protocol: 'config-v1',
    type: 'prepare',
    request_id: randomUUID(),
    operation_id: operationId,
    expected_revision: 0,
    target: KobraXNativeConfigurationTarget.parse({
      v: 1,
      protocol: 'config-v1',
      backend: 'kobra-x',
      model: { family: 'anycubic-kobra-x', provisional: true },
      endpoint: { ipv4: '192.168.1.50', port: 18910 },
      client_certificate: clientCertificate,
    }),
  }
}

function prepareKobraLinkFrame(
  operationId: string,
  clientCertificate: KobraClientCertificateInput,
): ConfigurationRequestFrame {
  return {
    v: 1,
    protocol: 'config-v1',
    type: 'prepare',
    request_id: randomUUID(),
    operation_id: operationId,
    expected_revision: 0,
    target: KobraConfigurationTarget.parse({
      v: 1,
      protocol: 'config-v1',
      backend: 'kobralink-anycubic',
      model: { family: 'anycubic-kobra-x', provisional: true },
      endpoint: { ipv4: '192.168.1.50', port: 18910 },
      bridge: { kind: 'connector-managed' },
      client_certificate: clientCertificate,
    }),
  }
}

test('refuses install-path imports outside documented locations with one generic error', async () => {
  const outside = makeTempDir('kobra-outside-')
  const { certPem, keyPem } = bundledKobraClientIdentity()
  const validCertDir = join(outside, 'AnycubicSlicerNext', 'resources')
  mkdirSync(validCertDir, { recursive: true })
  const combinedPath = join(validCertDir, 'client.pem')
  writeFileSync(combinedPath, `${certPem}\n${keyPem}`)
  const nonCertFile = join(outside, 'secret.txt')
  writeFileSync(nonCertFile, 'not a certificate\n')
  const symlinkPath = join(outside, 'link.pem')
  symlinkSync(combinedPath, symlinkPath)

  const candidates = [
    validCertDir,
    combinedPath,
    nonCertFile,
    join(outside, 'does-not-exist'),
    symlinkPath,
    '/etc/passwd',
    '/etc/nonexistent-openfarm-probe-598',
    '/opt/AnycubicSlicerNext/../../etc/passwd',
    '/opt/AnycubicSlicerNext-evil/resources',
    'relative/path/client.pem',
    '/opt/AnycubicSlicerNext/bad\0path',
  ]

  const results = []
  for (const candidate of candidates) {
    const res = await importKobraClientCertFromInput({
      kind: 'install-path',
      path: candidate,
    })
    assert.equal(res.ok, false, `expected refusal for ${candidate}`)
    if (res.ok) continue
    assert.equal(
      res.metadata,
      undefined,
      `unexpected metadata for ${candidate}`,
    )
    results.push({ candidate, reason: res.reason, message: res.message })
  }

  const first = results[0]!
  assert.equal(first.reason, 'missing')
  for (const item of results) {
    assert.equal(
      item.reason,
      first.reason,
      `distinct reason leaked for ${item.candidate}`,
    )
    assert.equal(
      item.message,
      first.message,
      `distinct message leaked for ${item.candidate}`,
    )
  }
})

test('allows documented user install location and hides failure distinctions inside it', async (t) => {
  const previousHome = process.env.HOME
  const tempHome = makeTempDir('kobra-home-')
  process.env.HOME = tempHome
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  })

  const outside = makeTempDir('kobra-escape-target-')
  const { certPem, keyPem } = bundledKobraClientIdentity()
  const escapedCert = join(outside, 'escaped.pem')
  writeFileSync(escapedCert, `${certPem}\n${keyPem}`)

  const allowedRoot = join(tempHome, '.local', 'share', 'AnycubicSlicerNext')
  const resourcesDir = join(allowedRoot, 'resources')
  mkdirSync(resourcesDir, { recursive: true })

  // Failures inside the allowed root must match the exact same generic error
  // returned for paths outside the allowed locations.
  const outsideRefusal = await importKobraClientCertFromInput({
    kind: 'install-path',
    path: outside,
  })
  assert.equal(outsideRefusal.ok, false)
  if (outsideRefusal.ok) return

  const invalidFile = join(resourcesDir, 'not-a-cert.pem')
  writeFileSync(invalidFile, 'invalid pem content\n')
  const escapedLink = join(resourcesDir, 'symlink.pem')
  symlinkSync(escapedCert, escapedLink)
  const dirEscapeLink = join(allowedRoot, 'escape-dir')
  symlinkSync(outside, dirEscapeLink)

  for (const failingAllowedPath of [
    join(resourcesDir, 'missing.pem'),
    invalidFile,
    escapedLink,
    dirEscapeLink,
    join(dirEscapeLink, 'escaped.pem'),
    resourcesDir,
  ]) {
    const res = await importKobraClientCertFromInput({
      kind: 'install-path',
      path: failingAllowedPath,
    })
    assert.equal(res.ok, false, `expected failure for ${failingAllowedPath}`)
    if (res.ok) continue
    assert.equal(res.reason, outsideRefusal.reason)
    assert.equal(res.message, outsideRefusal.message)
    assert.equal(res.metadata, undefined)
  }

  // Valid cert + sibling key inside the documented Linux user install location succeeds.
  const certFile = join(resourcesDir, 'client.crt')
  const keyFile = join(resourcesDir, 'client.key')
  writeFileSync(certFile, certPem)
  writeFileSync(keyFile, keyPem)

  const fromDir = await importKobraClientCertFromInput({
    kind: 'install-path',
    path: allowedRoot,
  })
  assert.equal(fromDir.ok, true)
  if (fromDir.ok) {
    assert.equal(fromDir.cert.commonName, 'AnycubicSlicer')
  }

  const fromDirectFile = await importKobraClientCertFromInput({
    kind: 'install-path',
    path: certFile,
  })
  assert.equal(fromDirectFile.ok, true)
})

test('provisioning engine refuses disallowed install paths with one generic error code and never probes', async (t) => {
  const previousHome = process.env.HOME
  const tempHome = makeTempDir('kobra-engine-home-')
  process.env.HOME = tempHome
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  })

  const outside = makeTempDir('kobra-engine-outside-')
  const { certPem, keyPem } = bundledKobraClientIdentity()
  const outsideCert = join(outside, 'client.pem')
  writeFileSync(outsideCert, `${certPem}\n${keyPem}`)
  const outsideJunk = join(outside, 'junk.txt')
  writeFileSync(outsideJunk, 'junk\n')

  let probeCalls = 0
  const world = createEngineWorld({
    kobraXProbe: async () => {
      probeCalls++
      return {
        ok: true,
        modelId: '20030',
        deviceId: 'kx-dev-1',
        model: 'Anycubic Kobra X',
        firmware: '2.0.2.8',
        pinSha256: 'a'.repeat(64),
      }
    },
  })

  const disallowedPaths = [
    outsideCert,
    outsideJunk,
    join(outside, 'missing'),
    '/etc/passwd',
    '/opt/AnycubicSlicerNext/../../etc/passwd',
  ]

  const codes = new Set<string>()
  for (const path of disallowedPaths) {
    const kobraXOp = randomUUID()
    const kobraXRes = await world.send(
      prepareKobraXFrame(kobraXOp, { kind: 'install-path', path }),
    )
    assert.equal(kobraXRes.type, 'error', `kobra-x must refuse ${path}`)
    if (kobraXRes.type === 'error') codes.add(kobraXRes.code)
    assert.equal(
      existsSync(stagedKobraCertPath(world.stateDirectory, kobraXOp)),
      false,
    )

    const bridgeOp = randomUUID()
    const bridgeRes = await world.send(
      prepareKobraLinkFrame(bridgeOp, { kind: 'install-path', path }),
    )
    assert.equal(bridgeRes.type, 'error', `kobralink must refuse ${path}`)
    if (bridgeRes.type === 'error') codes.add(bridgeRes.code)
    assert.equal(
      existsSync(stagedKobraCertPath(world.stateDirectory, bridgeOp)),
      false,
    )

    const staged = await stageKobraClientCert(
      world.stateDirectory,
      randomUUID(),
      { kind: 'install-path', path },
    )
    assert.equal(staged.ok, false)
    if (!staged.ok) codes.add(staged.code)
  }

  assert.equal(probeCalls, 0)
  assert.deepEqual([...codes], ['client-cert-missing'])

  // Allowed documented location with valid certificate prepares cleanly.
  const allowedDir = join(
    tempHome,
    '.local',
    'share',
    'AnycubicSlicerNext',
    'resources',
  )
  mkdirSync(allowedDir, { recursive: true })
  writeFileSync(join(allowedDir, 'client.pem'), `${certPem}\n${keyPem}`)

  const okOp = randomUUID()
  const okRes = await world.send(
    prepareKobraXFrame(okOp, { kind: 'install-path', path: allowedDir }),
  )
  assert.equal(okRes.type, 'result')
  if (okRes.type === 'result') {
    assert.equal(okRes.state, 'prepared')
  }
  assert.equal(probeCalls, 1)
})

test('restricts install-path allowlist to documented locations on linux, darwin, and win32', () => {
  // Linux
  assert.equal(
    isAllowedKobraInstallPath('/opt/AnycubicSlicerNext/resources', {
      platform: 'linux',
      homeDir: '/home/operator',
    }),
    true,
  )
  assert.equal(
    isAllowedKobraInstallPath(
      '/home/operator/.local/share/AnycubicSlicerNext/resources/client.crt',
      { platform: 'linux', homeDir: '/home/operator' },
    ),
    true,
  )
  for (const bad of [
    '/etc/passwd',
    '/opt/AnycubicSlicerNext-evil/resources',
    '/opt/AnycubicSlicerNext/../../etc/passwd',
    '/home/operator/.local/share/AnycubicSlicerNext-other',
    '/home/operator/.ssh/id_rsa',
    'relative/path',
    '/opt/AnycubicSlicerNext/\0bad',
  ]) {
    assert.equal(
      isAllowedKobraInstallPath(bad, {
        platform: 'linux',
        homeDir: '/home/operator',
      }),
      false,
      `linux must refuse ${bad}`,
    )
  }

  // macOS
  assert.equal(
    isAllowedKobraInstallPath(
      '/Applications/AnycubicSlicerNext.app/Contents/Resources',
      { platform: 'darwin', homeDir: '/Users/operator' },
    ),
    true,
  )
  for (const bad of [
    '/Applications/AnycubicSlicerNext.app-evil/Contents/Resources',
    '/Applications/AnycubicSlicerNext.app/../../etc/passwd',
    '/Users/operator/.ssh/id_rsa',
  ]) {
    assert.equal(
      isAllowedKobraInstallPath(bad, {
        platform: 'darwin',
        homeDir: '/Users/operator',
      }),
      false,
      `darwin must refuse ${bad}`,
    )
  }

  // Windows
  assert.equal(
    isAllowedKobraInstallPath(
      'c:\\program files\\AnycubicSlicerNext\\resources',
      {
        platform: 'win32',
        localAppData: 'C:\\Users\\Operator\\AppData\\Local',
      },
    ),
    true,
  )
  assert.equal(
    isAllowedKobraInstallPath(
      'C:\\Users\\Operator\\AppData\\Local\\AnycubicSlicerNext\\resources',
      {
        platform: 'win32',
        localAppData: 'C:\\Users\\Operator\\AppData\\Local',
      },
    ),
    true,
  )
  for (const bad of [
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    'C:\\Program Files\\AnycubicSlicerNext-evil\\resources',
    'C:\\Program Files\\AnycubicSlicerNext\\..\\..\\Windows\\win.ini',
    '\\\\evil-server\\share\\AnycubicSlicerNext',
    'D:\\Program Files\\AnycubicSlicerNext\\resources',
  ]) {
    assert.equal(
      isAllowedKobraInstallPath(bad, {
        platform: 'win32',
        localAppData: 'C:\\Users\\Operator\\AppData\\Local',
      }),
      false,
      `win32 must refuse ${bad}`,
    )
  }
})
