// Issue #9 mock candidate. Real timers, loopback Moonraker only.
// Do not enable mock.timers: the printing simulator needs live sockets.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openCommandJournal,
  closeCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { moonrakerWebUiOrigin } from '../../packages/connector/src/config/moonraker.ts'
import { resolvedLocalInterfaceOrigin } from '../../apps/farm/app/utils/farm-view.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

if (process.env.OPENFARM_SIM === 'docker')
  throw new Error('OPENFARM_SIM=docker is refused for issue #9')

const root = new URL('../..', import.meta.url)

function pauses(mock: Awaited<ReturnType<typeof startMoonrakerMock>>) {
  return mock.calls.all.filter((call) => call.method === 'printer.print.pause')
    .length
}

async function authority(now: number) {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { publicKey } = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const command = {
    v: 2 as const,
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: now,
    expires_at: now + 5000,
    nonce: randomBytes(16).toString('base64url'),
  }
  const { thumbprint } = await validateBrowserDevicePublicKey(publicKey)
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const { createHash } = await import('node:crypto')
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: command.transport_id,
    farm_id: command.farm_id,
    agent_id: command.agent_id,
    account_id: command.account_id,
    key_id: command.key_id,
    assignment_id: command.assignment_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const { controlBindingHash } =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const bindingHash = await controlBindingHash(binding)
  const admissionNonce = digest()
  const capability = {
    v: 1 as const,
    purpose: 'pause-authority' as const,
    capability_id: command.capability_id,
    kid: 'issuer-1',
    issuer: 'farm:issuer',
    audience: binding.audience,
    origin: binding.origin,
    issued_at: now,
    expires_at: now + 30000,
    account_id: command.account_id,
    role: 'operator' as const,
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_fingerprint: binding.connector_fingerprint,
    credential_jti: binding.credential_jti,
    printer_key: 'sv06',
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    actions: ['pause'] as ['pause'],
  }
  const challenge = {
    v: 1 as const,
    purpose: 'pause-admission' as const,
    challenge_id: randomUUID(),
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    account_id: binding.account_id,
    browser_thumbprint: thumbprint,
    origin: binding.origin,
    audience: binding.audience,
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    issued_at: now,
    expires_at: now + 8000,
  }
  return { pair, command, issuer, connector, binding, capability, challenge }
}

async function printingSession(t: test.TestContext) {
  if (process.env.OPENFARM_SIM === 'docker')
    throw new Error('OPENFARM_SIM=docker is refused for issue #9')
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  t.after(async () => {
    const errors: unknown[] = []
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Session cleanup failed')
  })
  let wall = Date.now()
  let mono = 0
  const monotonicNow = () => (mono += 0.001)
  const wallNow = () => wall
  const advance = (ms: number) => {
    wall += ms
    mono += ms
  }
  const auth = await authority(wall)
  const directory = mkdtempSync(join(tmpdir(), 'o3dfm-issue9-pause-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: wallNow })
  cleanup.push(() => closeCommandJournal(journal))
  const mock = await startMoonrakerMock({
    profile: 'sv06',
    initial: { state: 'printing', progress: 0.4, filename: 'dwell.gcode' },
  })
  cleanup.push(() => mock.close())
  assert.equal(new URL(mock.origin).hostname, '127.0.0.1')
  const registry = createPrinterBindingRegistry({
    allowedOrigins: [mock.origin],
  })
  const printerBinding = registry.provision({
    assignment_id: auth.binding.assignment_id,
    farm_id: auth.binding.farm_id,
    agent_id: auth.binding.agent_id,
    printer_key: auth.capability.printer_key,
    moonraker_origin: mock.origin,
  })
  let dispatcher: ReturnType<typeof createPauseDispatcher> | undefined
  const driver = createPauseDriverRouter({
    allowedOrigins: [mock.origin],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 3000,
      requestTimeoutMs: 3000,
      staleAfterMs: 2000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
    clock: { monotonicNow },
    observe: (binding, observation) =>
      dispatcher?.observe(binding, observation) ?? false,
  })
  cleanup.push(() => driver.closeAttempt(printerBinding))
  dispatcher = createPauseDispatcher({
    authority: {
      issuers: [
        {
          issuer: auth.capability.issuer,
          kid: auth.capability.kid,
          publicKey: auth.issuer.publicKey,
        },
      ],
    },
    clock: { wallNow, monotonicNow },
    journal,
    driver,
    resultTimeoutMs: 5000,
  })
  const active = dispatcher
  cleanup.push(() => active.close())
  const controls =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const caps =
    await import('../../packages/farm-protocol/src/pause-capability.ts')
  const admission = active.beginAdmission({
    binding: auth.binding,
    printerBinding,
    peer: active.createPeer(1).peer,
  })
  const nonce = admission.challenge.admissionNonce
  const capability = await caps.signPauseCapability(
    { ...auth.capability, issued_at: wallNow(), admission_nonce: nonce },
    auth.issuer.privateKey,
  )
  const proof = await caps.signPauseAdmissionProof(
    {
      ...auth.challenge,
      issued_at: wallNow(),
      expires_at: wallNow() + 8000,
      admission_nonce: nonce,
    },
    auth.pair.privateKey,
  )
  const accepted = await active.admit(admission.token, {
    capabilityWire: caps.encodePauseCapability(capability),
    admissionProofWire: caps.encodePauseAdmissionProof(proof),
    browserProofWire: controls.encodeControlProof({
      v: 1,
      role: 'browser',
      binding: auth.binding,
      signature: await controls.signControlSessionProof(
        auth.binding,
        'browser',
        auth.pair.privateKey,
      ),
    }),
    connectorProofWire: controls.encodeControlProof({
      v: 1,
      role: 'connector',
      binding: auth.binding,
      signature: await controls.signControlSessionProof(
        auth.binding,
        'connector',
        auth.connector.privateKey,
      ),
    }),
  })
  if (!accepted.ok) throw new Error(`not admitted: ${accepted.reason}`)
  const sign = async (
    patch: { farm_id?: string; assignment_id?: string } = {},
  ) => {
    const signed = await signCommandV2(
      {
        ...auth.command,
        ...patch,
        cmd_id: randomUUID(),
        nonce: randomBytes(16).toString('base64url'),
        issued_at: wallNow(),
        expires_at: wallNow() + 5000,
      },
      auth.pair.privateKey,
    )
    return {
      signed,
      input: {
        wire: encodeCommandV2(signed),
        capability: accepted.handle,
        printerBinding,
      },
    }
  }
  return { mock, dispatcher: active, sign, advance, printerBinding }
}

function tamper(wire: string) {
  const parsed = JSON.parse(wire) as { sig: string }
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  const chars = parsed.sig.split('')
  const current = chars[10]
  if (!current) throw new Error('Signature too short to tamper')
  chars[10] = alphabet[(alphabet.indexOf(current) + 1) % alphabet.length]!
  parsed.sig = chars.join('')
  return encodeCommandV2(parsed)
}

test(
  'signed pause against a printing Moonraker mock applies once',
  { timeout: 20000 },
  async (t) => {
    const session = await printingSession(t)
    const command = await session.sign()
    assert.deepEqual(await session.dispatcher.dispatch(command.input), {
      kind: 'applied',
      reason: 'applied',
      cmdId: command.signed.cmd_id,
    })
    assert.equal(session.mock.control.model().state, 'paused')
    assert.equal(pauses(session.mock), 1)
    assert.deepEqual(
      session.mock.calls.all.map((call) => call.method),
      ['printer.objects.query', 'printer.print.pause', 'printer.objects.query'],
    )
    const replay = await session.dispatcher.dispatch(command.input)
    assert.equal(replay.kind, 'rejected')
    assert.equal(replay.reason, 'replay')
    assert.equal(pauses(session.mock), 1)
    assert.equal(session.mock.control.model().state, 'paused')
  },
)

test(
  'tamper, scope and expiry never pause the printing mock',
  { timeout: 20000 },
  async (t) => {
    const session = await printingSession(t)
    const command = await session.sign()
    const tamperResult = await session.dispatcher.dispatch({
      ...command.input,
      wire: tamper(command.input.wire),
    })
    assert.equal(tamperResult.kind, 'rejected')
    assert.equal(tamperResult.reason, 'signature')

    const wrongFarm = await session.sign({ farm_id: randomUUID() })
    const farmResult = await session.dispatcher.dispatch(wrongFarm.input)
    assert.deepEqual(farmResult, { kind: 'rejected', reason: 'scope' })

    const wrongAssignment = await session.sign({ assignment_id: randomUUID() })
    const assignmentResult = await session.dispatcher.dispatch(
      wrongAssignment.input,
    )
    assert.deepEqual(assignmentResult, { kind: 'rejected', reason: 'scope' })

    const expired = await session.sign()
    session.advance(5000)
    const expiredResult = await session.dispatcher.dispatch(expired.input)
    assert.deepEqual(expiredResult, { kind: 'rejected', reason: 'expired' })

    assert.equal(pauses(session.mock), 0)
    assert.equal(session.mock.control.model().state, 'printing')
  },
)

test(
  'revoked capability never pauses the printing mock',
  { timeout: 20000 },
  async (t) => {
    const session = await printingSession(t)
    const command = await session.sign()
    assert.equal(session.dispatcher.revoke(command.input.capability), true)
    const result = await session.dispatcher.dispatch(command.input)
    assert.equal(result.kind, 'rejected')
    assert.equal(result.reason, 'invalid-authority')
    assert.equal(pauses(session.mock), 0)
    assert.equal(session.mock.control.model().state, 'printing')
  },
)

test('printer UI link is the mock host without the API port', async () => {
  const mock = await startMoonrakerMock({ profile: 'sv06' })
  try {
    const ui = moonrakerWebUiOrigin(mock.origin)
    assert.equal(ui, 'http://127.0.0.1')
    assert.equal(resolvedLocalInterfaceOrigin(null, ui), ui)
    assert.notEqual(ui, mock.origin)
    const page = readFileSync(
      new URL('apps/farm/app/pages/farm.vue', root),
      'utf8',
    )
    assert.match(page, /resolvedLocalInterfaceOrigin\(/)
    assert.match(page, /:href="displayLocalOrigin\(row\) \?\? undefined"/)
    assert.match(page, /target="_blank"/)
    assert.match(page, /rel="noopener noreferrer"/)
    assert.match(page, /referrerpolicy="no-referrer"/)
  } finally {
    await mock.close()
  }
})

test('tablet layout source contract is two columns from 48rem', () => {
  const css = readFileSync(
    new URL('apps/farm/app/components/farm/farm-view.css', root),
    'utf8',
  )
  const spec = readFileSync(
    new URL('tests/e2e/farm-view.spec.ts', root),
    'utf8',
  )
  assert.match(
    css,
    /@media \(min-width: 48rem\) \{[\s\S]*?\.printers \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  )
  assert.match(spec, /width >= 768 \? 2 : 1/)
})
