import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { AuthenticatedConnectorSignallingClient } from '../../packages/connector/src/cloud/authenticated-signalling-client.ts'
import { AuthenticatedBrowserSignallingClient } from '../../apps/farm/app/utils/webrtc/authenticated-signalling-client.ts'

import {
  parseRtcFixtureCommand,
  RtcFixtureReply,
  RTC_FIXTURE_IPC_BYTES,
} from '../helpers/signalling-rtc-connector-child.ts'
import { createAuthenticatedRtcFixtureExtension } from '../helpers/signalling-authenticated-rtc.ts'
import type { SignallingFixtureExtension } from '../helpers/signalling-https-fixture-contract.ts'

/** Pure projection checks only: no sockets, child process, or native RTC imports. */
test('unstarted and terminal Connector diagnostics are bounded immutable nonsecret projections', () => {
  const client = new AuthenticatedConnectorSignallingClient({
    url: 'wss://farm.example/api/signalling/connector',
    origin: 'https://farm.example',
    audience: 'test-audience',
    agentId: randomUUID(),
    farmId: randomUUID(),
    jti: randomUUID(),
    token: 'private-test-token',
    identity: new ConnectorIdentity(generateKeyPairSync('ed25519').privateKey),
  })
  try {
    const before = client.diagnostics()
    assert.deepEqual(before, {
      certificateMatched: false,
      sentProofs: 0,
      receivedProofs: 0,
      terminal: false,
      readOnly: true,
    })
    assert.equal(Object.isFrozen(before), true)
    assert.deepEqual(Object.keys(before).sort(), [
      'certificateMatched',
      'readOnly',
      'receivedProofs',
      'sentProofs',
      'terminal',
    ])
    client.close()
    assert.deepEqual(client.diagnostics(), { ...before, terminal: true })
    assert.equal(before.terminal, false)
  } finally {
    client.close()
  }
})

test('browser diagnostics require an actual adopted peer and never expose credentials or key scope', async () => {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let factoryCalls = 0
  const client = new AuthenticatedBrowserSignallingClient(
    {
      farmId: randomUUID(),
      agentId: randomUUID(),
      keyId: randomUUID(),
      accountId: 'private-test-account',
      origin: 'https://farm.example',
      audience: 'test-audience',
      privateKey: keys.privateKey,
      publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    },
    {
      peerFactory: () => {
        factoryCalls++
        throw Error('must not run')
      },
    },
  )
  try {
    const before = client.diagnostics()
    assert.deepEqual(before, {
      certificateMatched: false,
      sentProofs: 0,
      receivedProofs: 0,
      terminal: false,
      readOnly: true,
    })
    assert.equal(Object.isFrozen(before), true)
    client.close()
    assert.deepEqual(client.diagnostics(), { ...before, terminal: true })
    assert.equal(factoryCalls, 0)
  } finally {
    client.close()
  }
})

test('RTC extension factory is inert and uses the frozen fixture seam', () => {
  const before = process.getActiveResourcesInfo().sort()
  const extension: SignallingFixtureExtension =
    createAuthenticatedRtcFixtureExtension()
  assert.deepEqual(Object.keys(extension).sort(), [
    'afterProvisioned',
    'identityHandles',
  ])
  assert.equal(Object.isFrozen(extension), true)
  assert.deepEqual(process.getActiveResourcesInfo().sort(), before)
})

test('private RTC IPC accepts only bounded controls and the authoritative approved claim', () => {
  const agentId = randomUUID(),
    farmId = randomUUID()
  const start = {
    kind: 'start',
    origin: 'https://127.0.0.1:4443',
    audience: 'open3dfarmmanager:signalling',
    claim: {
      status: 'approved',
      agent_id: agentId,
      farm_id: farmId,
      device_token: 'aaaa.bbbb.cccc',
      expires_at: Date.now() + 30000,
    },
    assignmentRefs: [
      {
        assignmentId: randomUUID(),
        agentId,
        printerKey: 'synthetic-readonly-printer',
      },
    ],
  }
  assert.deepEqual(parseRtcFixtureCommand(JSON.stringify(start)), start)
  assert.deepEqual(parseRtcFixtureCommand('{"kind":"observe"}'), {
    kind: 'observe',
  })
  assert.deepEqual(parseRtcFixtureCommand('{"kind":"advance-runtime"}'), {
    kind: 'advance-runtime',
  })
  assert.equal(
    RtcFixtureReply.safeParse({
      kind: 'runtime-observation',
      requests: 1,
      queued: 1,
      failure: false,
      settled: false,
      directory: '/tmp/owned-runtime-fixture',
      port: 12345,
      admitted: 0,
      terminalReason: null,
    }).success,
    true,
  )
  assert.equal(
    RtcFixtureReply.safeParse({
      kind: 'runtime-observation',
      requests: 1000,
      queued: 1,
      failure: false,
      settled: false,
      directory: '/tmp/owned-runtime-fixture',
      port: 12345,
      admitted: 0,
      terminalReason: null,
    }).success,
    false,
  )
  for (const command of [
    { ...start, claim: { status: 'pending', retry_after_s: 5 } },
    { ...start, assignmentRefs: [] },
    {
      ...start,
      assignmentRefs: [...start.assignmentRefs, ...start.assignmentRefs],
    },
    { ...start, assignmentRefs: [{ ...start.assignmentRefs[0], extra: true }] },
    { ...start, claim: { ...start.claim, device_token: 'a'.repeat(8193) } },
    { kind: 'observe', token: 'private-token' },
    { kind: 'admit', binding: {} },
    { kind: 'answer', sdp: 'forbidden fixture shortcut' },
    { kind: 'proof', signature: 'forbidden fixture shortcut' },
  ])
    assert.throws(() => parseRtcFixtureCommand(JSON.stringify(command)))
  assert.throws(() =>
    parseRtcFixtureCommand('{"kind":"observe","kind":"identity"}'),
  )
  assert.throws(() =>
    parseRtcFixtureCommand(' '.repeat(RTC_FIXTURE_IPC_BYTES + 1)),
  )
})

test('RTC child reply boundary excludes credentials, SDP, private keys and unbounded diagnostics', () => {
  const reply = {
    kind: 'observation',
    terminalReason: null,
    inboxReady: false,
    verifiedAdmission: true,
    diagnosticsImmutable: true,
    provider: 'finite-synthetic-assigned-status',
    published: 1,
    providerClosed: false,
    sourceRemainingMs: 12000,
    diagnostics: {
      certificateMatched: true,
      sentProofs: 1,
      receivedProofs: 1,
      terminal: false,
      readOnly: true,
    },
  }
  assert.deepEqual(RtcFixtureReply.parse(reply), reply)
  for (const extra of [
    { token: 'private-token' },
    { sdp: 'private-description' },
    { privateKey: 'forbidden' },
  ])
    assert.equal(
      RtcFixtureReply.safeParse({ ...reply, ...extra }).success,
      false,
    )
  for (const diagnostics of [
    { ...reply.diagnostics, readOnly: false },
    { ...reply.diagnostics, sentProofs: 2 },
    { ...reply.diagnostics, receivedProofs: -1 },
    { ...reply.diagnostics, binding: {} },
  ])
    assert.equal(
      RtcFixtureReply.safeParse({ ...reply, diagnostics }).success,
      false,
    )
  assert.equal(
    RtcFixtureReply.safeParse({ ...reply, published: 2 }).success,
    false,
  )
})

/** Actual runtime acceptance belongs to the sealed parent's --run path. This
 * gate intentionally creates no substitute HTTP, WS, identity or SDP fixture.
 * Supply fresh external SIGNALLING_HTTPS_LEDGER paths for each selected closure.
 */
for (const closure of ['disconnect', 'revocation']) {
  test(
    `opt-in authenticated HTTPS/RTC ${closure} uses the parent fixture`,
    {
      skip: process.env.SIGNALLING_HTTPS_RTC_FIXTURE !== 'yes',
      timeout: 210000,
    },
    async () => {
      assert.equal(process.env.SIGNALLING_HTTPS_DISPOSABLE, 'yes')
      const ledger = process.env.SIGNALLING_HTTPS_LEDGER
      assert.ok(
        ledger,
        'Parent must supply an external resource baseline ledger',
      )
      const { spawn } = await import('node:child_process')
      const { open, readFile, stat, appendFile } = await import(
        'node:fs/promises'
      )
      const driverPath = `${ledger}.${closure}.test-driver.jsonl`
      const driver = await open(driverPath, 'ax', 0o600)
      await driver.close()
      const { waitFixtureClose } = await import(
        '../helpers/signalling-https-process.ts'
      )
      const child = spawn(
        process.execPath,
        [
          new URL('../../scripts/test-signalling-https.ts', import.meta.url)
            .pathname,
          '--run',
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            SIGNALLING_HTTPS_RTC_CLOSURE: closure,
            SIGNALLING_HTTPS_LEDGER: `${ledger}.${closure}`,
            SIGNALLING_AUTHENTICATED_RTC_LEDGER: `${ledger}.${closure}.rtc-resources.jsonl`,
          },
        },
      )
      const closed = new Promise<unknown[]>((resolve) =>
        child.once('close', (code, signal) => resolve([code, signal])),
      )
      let failed = false,
        bytes = 0
      child.on('error', () => {
        failed = true
      })
      const drain = (chunk: Buffer) => {
        bytes += chunk.byteLength
        // No raw logs or secrets retained or echoed by this test.
        if (bytes > 65536) {
          failed = true
          child.kill('SIGTERM')
        }
      }
      child.stdout.on('data', drain)
      child.stderr.on('data', drain)
      try {
        await appendFile(
          driverPath,
          JSON.stringify({ event: 'parent-fixture-created', pid: child.pid }) +
            '\n',
        )
        const [code, signal] = await waitFixtureClose(closed, 180000)
        assert.equal(failed, false)
        assert.equal(code, 0)
        assert.equal(signal, null)
        const resources = `${ledger}.${closure}.rtc-resources.jsonl`
        assert.ok((await stat(resources)).size <= 65536)
        const receipts = (await readFile(resources, 'utf8'))
          .trim()
          .split('\n')
          .map((line): unknown => JSON.parse(line))
        for (const event of [
          `authenticated-rtc-${closure}-verified-status-and-remote-close`,
          'connector-child-close-drained',
          'browser-actor-and-route-disposed; parent-owns-pages-and-context',
        ]) {
          assert.ok(
            receipts.some(
              (receipt) =>
                !!receipt &&
                typeof receipt === 'object' &&
                'event' in receipt &&
                receipt.event === event,
            ),
            `Missing actual RTC receipt: ${event}`,
          )
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          try {
            await waitFixtureClose(closed, 3000)
          } catch {
            child.kill('SIGKILL')
            await waitFixtureClose(closed, 3000)
          }
        }
        const [code, signal] = await closed
        await appendFile(
          driverPath,
          JSON.stringify({
            event: 'parent-fixture-close-drained',
            code,
            signal,
          }) + '\n',
        )
      }
    },
  )
}
