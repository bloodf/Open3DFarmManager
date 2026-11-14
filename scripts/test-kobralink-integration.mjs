// SPDX-License-Identifier: MIT
// The caller must first safely restart the exclusively owned Lima profile.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  cpSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKobraLinkClient } from '../packages/connector/src/kobralink/client.ts'
import { createSyntheticTls } from '../tests/fixtures/kobralink-integration/tls.ts'

import { createKobraLinkRuntimeSubscription } from '../packages/connector/src/kobralink/runtime.ts'
import { createFarmSnapshotSource } from '../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { collectIntoQueue } from '../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../packages/connector/src/cloud/queue.ts'
import { setupProvisioning } from '../tests/fixtures/kobralink-integration/provisioning.ts'
import { createProvisioningEngine } from '../packages/connector/src/provisioning/index.ts'
import {
  configurationReceiptHash,
  verifyConfigurationReceipt,
} from '../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../packages/farm-protocol/src/configuration-target.ts'

assert.equal(process.env.DOCKER_CONTEXT, 'colima-openfarm-kobralink-togiej')
assert.equal(process.env.KOBRALINK_INTEGRATION_OWNED, 'yes')
assert.ok(process.env.KOBRALINK_SRC)
const project = 'openfarm-kobralink-qualified'
const fixture = `${project}-fixture`
const network = `${project}-net`
const image =
  'sha256:9865baa7346eb87d8860ced1881c30a1e5600b979d618c44757228407dce22e3'
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  KOBRALINK_IMAGE: image,
  KOBRALINK_MGMT_PORT: '17100',
  KOBRALINK_AUTH_SECRET: randomBytes(32).toString('hex'),
}
const docker = (...args) =>
  execFileSync('docker', ['--context', env.DOCKER_CONTEXT, ...args], {
    env,
    encoding: 'utf8',
    timeout: 120000,
  })
const compose = (...args) =>
  docker('compose', '-f', 'infra/kobralink/docker-compose.yml', ...args)
const passed = []
let completed = false
let stage = 'preflight'
let provisioning
let netOwned = false
let fixtureOwned = false
const extraFixtures = []
let composeOwned = false
const temp = mkdtempSync(join(tmpdir(), 'openfarm-kobralink-qualified-'))
const client = createKobraLinkClient({
  origin: 'http://127.0.0.1:17100',
  allowedOrigins: ['http://127.0.0.1:17100'],
  timeoutMs: 15000,
  fetch: async (url, init) => {
    const response = await fetch(url, init)
    console.log(
      JSON.stringify({
        path: new URL(url).pathname,
        method: init.method,
        status: response.status,
      }),
    )
    return response
  },
})
async function waitForHost() {
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    ready = await fetch('http://127.0.0.1:17100/api/auth/ok', {
      signal: AbortSignal.timeout(1000),
    }).then(
      (r) => r.ok,
      () => false,
    )
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(ready, true)
}
try {
  assert.equal(
    docker('image', 'inspect', image, '--format', '{{.Id}}').trim(),
    image,
  )
  assert.equal(docker('ps', '-aq', '--filter', `name=^/${fixture}$`).trim(), '')
  assert.equal(
    docker('network', 'ls', '-q', '--filter', `name=^${network}$`).trim(),
    '',
  )
  assert.equal(
    docker('volume', 'ls', '-q', '--filter', `name=^${project}-data$`).trim(),
    '',
  )
  assert.equal(
    execFileSync('git', ['-C', env.KOBRALINK_SRC, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    '5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1',
  )
  assert.equal(
    execFileSync('git', ['-C', env.KOBRALINK_SRC, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim(),
    '',
  )
  compose('config', '--quiet')
  execFileSync(
    'limactl',
    [
      'shell',
      'colima-openfarm-kobralink-togiej',
      'sudo',
      'iptables',
      '-C',
      'DOCKER-USER',
      '-s',
      '172.30.78.0/24',
      '!',
      '-d',
      '172.30.78.0/24',
      '-m',
      'conntrack',
      '--ctstate',
      'NEW',
      '-j',
      'DROP',
    ],
    { env: { ...env, LIMA_HOME: `${process.env.HOME}/.colima/_lima` } },
  )
  docker(
    'network',
    'create',
    '--subnet',
    '172.30.78.0/24',
    '--label',
    'com.docker.compose.network=kobralink-net',
    '--label',
    `com.docker.compose.project=${project}`,
    network,
  )
  netOwned = true
  cpSync(
    new URL('../tests/fixtures/kobralink-integration/', import.meta.url),
    temp,
    { recursive: true },
  )
  const tls = createSyntheticTls()
  writeFileSync(join(temp, 'key.pem'), tls.key, { mode: 0o600 })
  writeFileSync(join(temp, 'cert.pem'), tls.cert, { mode: 0o600 })
  docker(
    'create',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--name',
    fixture,
    '--network',
    network,
    '--ip',
    '172.30.78.3',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-e',
    'OPENFARM_SYNTHETIC_KOBRA_NETWORK=owned-isolated',
    '--entrypoint',
    'bun',
    image,
    '/fixture/serve.ts',
  )
  fixtureOwned = true
  docker('cp', `${temp}/.`, `${fixture}:/fixture`)
  docker('start', fixture)
  const fixtureInfo = JSON.parse(docker('inspect', fixture))[0]
  assert.equal(
    fixtureInfo.NetworkSettings.Networks[network].IPAddress,
    '172.30.78.3',
  )
  assert.deepEqual(fixtureInfo.HostConfig.PortBindings, {})
  stage = 'compose health'
  composeOwned = true
  compose('up', '--no-build', '--wait', '--wait-timeout', '60')
  const service = JSON.parse(docker('inspect', `${project}-service`))[0]
  assert.deepEqual(service.HostConfig.PortBindings, {
    '7100/tcp': [{ HostIp: '127.0.0.1', HostPort: '17100' }],
  })
  assert.equal(
    JSON.parse(docker('network', 'inspect', network))[0].Internal,
    false,
  )
  assert.equal(service.Image, image)
  for (const entry of [
    'KOBRALINK_UPDATE_REPO=',
    'KOBRALINK_EXTRA_ORIGINS=',
    'DATABASE_URL=file:/data/kobralink.db',
    'BETTER_AUTH_URL=http://127.0.0.1:17100',
  ])
    assert.ok(service.Config.Env.includes(entry))
  assert.ok(
    service.Mounts.some(
      (m) =>
        m.Type === 'volume' &&
        m.Name === `${project}-data` &&
        m.Destination === '/data',
    ),
  )
  passed.push(
    'unchanged compose healthy; exact image; egress-denied network; loopback management only',
  )
  stage = 'host readiness'
  await waitForHost()
  docker(
    'exec',
    `${project}-service`,
    'bun',
    '-e',
    "fetch('http://192.0.2.1', {signal: AbortSignal.timeout(1000)}).then(() => process.exit(1), () => process.exit(0))",
  )
  const listeners = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.startsWith('limactl'))
  assert.ok(listeners.some((line) => line.includes('127.0.0.1:17100')))
  assert.ok(
    listeners.every(
      (line) => !line.includes('*:') && !line.includes('0.0.0.0:'),
    ),
  )
  passed.push('egress probe denied; owned host listeners loopback only')
  stage = 'authentication'
  assert.equal((await client.setupStatus()).needsSetup, true)
  stage = 'first prepare without deviceId'
  provisioning = await setupProvisioning()
  const operation = randomUUID()
  const prepared = await provisioning.handle(
    createProvisioningEngine(provisioning.options),
    {
      type: 'prepare',
      operation_id: operation,
      target: provisioning.target,
    },
  )
  console.log(
    JSON.stringify({
      stage,
      response: prepared.type,
      state: prepared.state,
      code: prepared.code,
    }),
  )
  assert.equal(prepared.type, 'result')
  assert.equal(prepared.state, 'prepared')
  assert.equal(
    await verifyConfigurationReceipt(
      prepared.receipt,
      provisioning.keys.publicKey,
    ),
    true,
  )
  passed.push('first prepare without deviceId and verified signed receipt')
  stage = 'commit discovered identity'
  const committed = await provisioning.handle(
    createProvisioningEngine(provisioning.options),
    {
      type: 'commit',
      operation_id: operation,
      target_sha256: await configurationTargetHash(provisioning.target),
      prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
    },
  )
  assert.equal(committed.state, 'local-committed')
  assert.equal(
    await verifyConfigurationReceipt(
      committed.receipt,
      provisioning.keys.publicKey,
    ),
    true,
  )
  passed.push('identity committed with verified receipt')
  const custody = JSON.parse(
    readFileSync(
      join(provisioning.dir, 'state', 'bridge-custody.json'),
      'utf8',
    ),
  )
  const credentials = {
    ownership: 'fresh_owned',
    mode: 'signin',
    ...custody.bridges[0].account,
  }
  await client.authenticate(credentials)
  const identities = await client.listPrinterIdentities()
  assert.equal(identities.length, 1)
  const identity = identities[0]
  assert.equal(identity.deviceId, 'OPENFARM_SYNTHETIC_KOBRA_X_001')
  stage = 'MQTT observation'
  let observation
  for (let attempt = 0; attempt < 20; attempt++) {
    observation = await client.getPrinterObservation({
      id: identity.id,
      deviceId: identity.deviceId,
    })
    if (observation.availability === 'available') break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(observation.availability, 'available')
  await new Promise((resolve) => setTimeout(resolve, 2100))
  assert.match(docker('logs', fixture), /"accepted":[1-9]/)
  passed.push('real upstream MQTT and client observation')
  stage = 'Connector runtime subscription'
  const runtime = JSON.parse(
    readFileSync(provisioning.runtimeConfigPath, 'utf8'),
  )
  const binding = runtime.collection.kobralink.printers[0]
  const controller = new AbortController()
  let subscription
  try {
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Connector observation deadline')),
        15000,
      )
      subscription = createKobraLinkRuntimeSubscription({
        binding,
        allowedOrigins: [binding.origin],
        signal: controller.signal,
        onStatus: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        onUnavailable: () => {},
      })
    })
    assert.equal(status.deviceId, identity.deviceId)
    assert.equal(status.availability, 'available')
    assert.equal(status.firmware, 'SYNTHETIC-0.0.0')
  } finally {
    controller.abort()
    await subscription?.done
  }
  passed.push(
    'Connector runtime authenticated subscription with synthetic firmware',
  )
  stage = 'normalized Connector telemetry'
  const queue = new TelemetryQueue(join(provisioning.dir, 'queue'), Date.now())
  const collectorAbort = new AbortController()
  let raw
  const deadline = setTimeout(() => collectorAbort.abort(), 15000)
  try {
    await collectIntoQueue({
      config: { ...runtime.collection, printers: [] },
      queue,
      signal: collectorAbort.signal,
      onRawObservation: (value) => {
        raw = value
      },
      onDiagnostic: (value) => {
        if (value.kind === 'queued') collectorAbort.abort()
      },
    })
    assert.ok(raw)
    assert.equal(queue.depth, 1)
    const refs = runtime.assignments
      .filter((a) => a.backend === 'kobralink')
      .map((a) => ({
        assignmentId: a.assignment_id,
        agentId: a.agent_id,
        printerKey: a.printer_key,
      }))
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    try {
      source.observe(raw)
      let snapshot
      source.open({
        binding: { agent_id: provisioning.options.runtime.agent_id },
        assignmentRefs: refs,
        signal: new AbortController().signal,
        deadlineMonoMs: performance.now() + 5000,
        onComplete: (value) => {
          snapshot = value
        },
        onUnavailable: () => {},
      })
      assert.equal(snapshot.printers.length, 1)
    } finally {
      source.close()
    }
  } finally {
    clearTimeout(deadline)
    collectorAbort.abort()
    queue.close()
  }
  passed.push('normalized Connector observation and persisted telemetry')
  stage = 'reconcile'
  assert.equal(
    (
      await client.createOrReconcile({
        ip: '172.30.78.3',
        deviceId: identity.deviceId,
        name: 'SYNTHETIC Kobra X',
      })
    ).id,
    identity.id,
  )
  assert.equal((await client.listPrinters()).length, 1)
  passed.push('reconcile preserves identity')
  stage = 'restart persistence'
  compose('restart')
  compose('up', '--no-build', '--wait', '--wait-timeout', '60')
  await waitForHost()
  client.clearSession()
  await client.authenticate({ ...credentials, mode: 'signin' })
  assert.equal(
    (await client.getPrinter({ id: identity.id, deviceId: identity.deviceId }))
      .deviceId,
    identity.deviceId,
  )
  assert.deepEqual(
    JSON.parse(readFileSync(provisioning.runtimeConfigPath, 'utf8')),
    runtime,
  )
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        join(provisioning.dir, 'state', 'bridge-custody.json'),
        'utf8',
      ),
    ),
    custody,
  )
  passed.push(
    'restart identity authentication runtime configuration and custody persistence',
  )
  stage = 'changed identity isolation'
  await assert.rejects(
    client.getPrinter({ id: identity.id, deviceId: 'SYNTHETIC_CHANGED' }),
    { code: 'identity_changed' },
  )
  passed.push('changed identity rejected')
  stage = 'stale observation'
  docker('kill', '--signal', 'STOP', fixture)
  await new Promise((resolve) => setTimeout(resolve, 17000))
  const stale = await client.getPrinterObservation({
    id: identity.id,
    deviceId: identity.deviceId,
  })
  assert.equal(stale.availability, 'unavailable')
  assert.equal(stale.printState, 'unknown')
  docker('kill', '--signal', 'CONT', fixture)
  passed.push('stale observation is unavailable and unknown')
  stage = 'offline observation'
  docker('kill', '--signal', 'USR1', fixture)
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const offline = await client.getPrinterObservation({
    id: identity.id,
    deviceId: identity.deviceId,
  })
  assert.notEqual(offline.availability, 'available')
  assert.equal(offline.printState, 'unknown')
  passed.push('offline observation is disconnected and unknown')
  stage = 'reconnect observation'
  docker('kill', '--signal', 'USR2', fixture)
  const bindingOnly = { id: identity.id, deviceId: identity.deviceId }
  await client.reconnect(bindingOnly)
  let reconnected
  for (let attempt = 0; attempt < 30; attempt++) {
    reconnected = await client.getPrinterObservation(bindingOnly)
    if (reconnected.availability === 'available') break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(reconnected.availability, 'available')
  passed.push('reconnect with unchanged synthetic credentials')
  stage = 'partial create response reconciliation'
  const partialFixture = `${project}-partial`
  const partialId = 'OPENFARM_SYNTHETIC_PARTIAL'
  assert.equal(
    docker('ps', '-aq', '--filter', `name=^/${partialFixture}$`).trim(),
    '',
  )
  docker(
    'create',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--name',
    partialFixture,
    '--network',
    network,
    '--ip',
    '172.30.78.5',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-e',
    'OPENFARM_SYNTHETIC_KOBRA_NETWORK=owned-isolated',
    '-e',
    `SYNTHETIC_DEVICE_ID=${partialId}`,
    '--entrypoint',
    'bun',
    image,
    '/fixture/serve.ts',
  )
  extraFixtures.push(partialFixture)
  docker('cp', `${temp}/.`, `${partialFixture}:/fixture`)
  docker('start', partialFixture)
  assert.equal(
    JSON.parse(docker('inspect', partialFixture))[0].NetworkSettings.Networks[
      network
    ].IPAddress,
    '172.30.78.5',
  )
  await new Promise((resolve) => setTimeout(resolve, 1000))
  let lost = false
  const partialClient = createKobraLinkClient({
    origin: binding.origin,
    allowedOrigins: [binding.origin],
    fetch: async (url, init) => {
      const response = await fetch(url, init)
      if (
        init.method === 'POST' &&
        new URL(url).pathname === '/api/v1/printers' &&
        response.ok
      ) {
        lost = true
        await response.body.cancel()
        throw new Error('Synthetic response loss after real upstream create')
      }
      return response
    },
  })
  try {
    await partialClient.authenticate({ ...credentials, mode: 'signin' })
    const recovered = await partialClient.createOrReconcile({
      ip: '172.30.78.5',
      name: 'SYNTHETIC partial response',
      deviceId: partialId,
    })
    assert.equal(lost, true)
    assert.equal(recovered.deviceId, partialId)
    assert.equal((await client.listPrinters()).length, 2)
  } finally {
    partialClient.clearSession()
  }
  passed.push(
    'real create reconciled after injected response loss without duplicate',
  )
  stage = 'malformed identity isolation'
  const malformedFixture = `${project}-malformed`
  assert.equal(
    docker('ps', '-aq', '--filter', `name=^/${malformedFixture}$`).trim(),
    '',
  )
  docker(
    'create',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--name',
    malformedFixture,
    '--network',
    network,
    '--ip',
    '172.30.78.4',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-e',
    'OPENFARM_SYNTHETIC_KOBRA_NETWORK=owned-isolated',
    '-e',
    `SYNTHETIC_DEVICE_ID=OPENFARM_SYNTHETIC_${'X'.repeat(128)}`,
    '--entrypoint',
    'bun',
    image,
    '/fixture/serve.ts',
  )
  extraFixtures.push(malformedFixture)
  docker('cp', `${temp}/.`, `${malformedFixture}:/fixture`)
  docker('start', malformedFixture)
  assert.equal(
    JSON.parse(docker('inspect', malformedFixture))[0].NetworkSettings.Networks[
      network
    ].IPAddress,
    '172.30.78.4',
  )
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await assert.rejects(
    client.createPrinter({
      ip: '172.30.78.4',
      name: 'SYNTHETIC malformed identity',
    }),
    { code: 'invalid' },
  )
  assert.equal(
    (await client.getPrinter(bindingOnly)).deviceId,
    identity.deviceId,
  )
  passed.push(
    'malformed discovered identity refused; established device remains readable',
  )
  stage = 'wrong authentication'
  await assert.rejects(
    client.authenticate({
      ...credentials,
      mode: 'signin',
      password: randomBytes(24).toString('hex'),
    }),
    { code: 'unauthorized' },
  )
  passed.push('wrong authentication rejected')
  completed = true
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      stage,
      passed,
      error: error instanceof Error ? error.message : 'unknown',
      image,
    }),
  )
  if (fixtureOwned) console.error(docker('logs', '--tail', '10', fixture))
  process.exitCode = 1
} finally {
  client.clearSession()
  if (composeOwned) compose('down', '--volumes')
  for (const owned of extraFixtures) docker('rm', '-fv', owned)
  if (fixtureOwned) docker('rm', '-fv', fixture)
  if (
    netOwned &&
    docker('network', 'ls', '-q', '--filter', `name=^${network}$`).trim()
  )
    docker('network', 'rm', network)
  if (provisioning) rmSync(provisioning.dir, { recursive: true, force: true })
  rmSync(temp, { recursive: true, force: true })
}

if (completed) {
  assert.equal(docker('ps', '-aq', '--filter', `name=${project}`).trim(), '')
  assert.equal(
    docker('volume', 'ls', '-q', '--filter', `name=^${project}-data$`).trim(),
    '',
  )
  assert.equal(
    docker('network', 'ls', '-q', '--filter', `name=^${network}$`).trim(),
    '',
  )
  passed.push(
    'owned containers volumes network and private temporary credentials removed',
  )
  console.log(JSON.stringify({ status: 'pass', passed, image }))
}
