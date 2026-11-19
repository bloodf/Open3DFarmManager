import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import type { WebSocket } from 'ws'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  buildMoonrakerCommand,
  supportedMoonrakerActions,
} from '../../packages/connector/src/moonraker/commands.ts'
import { moonrakerControls } from '../../packages/connector/src/moonraker/control-support.ts'
import {
  encodeCommandV2,
  signCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  ControlArguments,
  controlRoleAllowed,
  controlSourceState,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { controlWithinLimits } from '../../packages/connector/src/runtime/control-limits.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'

// Loopback fixture only (127.0.0.1, port 0). The authority, capability and
// command are synthetic; nothing here reaches a physical printer.
const LIMITS = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 2000,
  requestTimeoutMs: 2000,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
let lastMono = 0
const monotonicNow = () =>
  (lastMono = Math.max(performance.now(), lastMono + 0.001))
const OBJECTS = [
  'extruder',
  'heater_bed',
  'fan_generic exhaust',
  'controller_fan electronics',
  'neopixel chamber_led',
  'led status',
  'output_pin caselight',
  'output_pin psu',
]

type Printer = {
  /** Moonraker print_stats.state reported by the fixture. */
  state: 'standby' | 'printing' | 'paused'
  objects?: readonly string[]
}

const reply = (socket: WebSocket, id: number, result: unknown) =>
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))

async function world(
  t: TestContext,
  printer: Printer,
  action: string,
  args: Record<string, unknown>,
) {
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  t.onTestFinished(async () => {
    for (const dispose of cleanup.reverse()) await dispose()
  })
  const now = Date.now()
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
  const { thumbprint } = await validateBrowserDevicePublicKey(publicKey)
  const ids = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const account_id = 'legacy_account'
  const printer_key = 'printer-outputs'
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
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: ids.transport_id,
    farm_id: ids.farm_id,
    agent_id: ids.agent_id,
    account_id,
    key_id: ids.key_id,
    assignment_id: ids.assignment_id,
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

  const directory = mkdtempSync(join(tmpdir(), 'control-outputs-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  // Query 1 is the prepare read; there is no further probe for outputs.
  const remote = await pauseFixture({
    objects: printer.objects ?? OBJECTS,
    query: (index, socket, id) => {
      reply(socket, id, {
        eventtime: index,
        status: {
          webhooks: { state: 'ready' },
          print_stats: { state: printer.state },
        },
      })
      return true
    },
  })
  cleanup.push(() => remote.close())
  const printerBinding = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  }).provision({
    assignment_id: ids.assignment_id,
    farm_id: ids.farm_id,
    agent_id: ids.agent_id,
    printer_key,
    moonraker_origin: remote.origin,
  })
  let dispatcher: ReturnType<typeof createPauseDispatcher> | undefined
  const router = createPauseDriverRouter({
    allowedOrigins: [remote.origin],
    limits: LIMITS,
    clock: { monotonicNow },
    observe: (target, observation) =>
      dispatcher?.observe(target, observation) ?? false,
  })
  cleanup.push(() => router.closeAttempt(printerBinding))
  await router.detect(printerBinding)
  dispatcher = createPauseDispatcher({
    authority: {
      issuers: [
        { issuer: 'farm:issuer', kid: 'issuer-1', publicKey: issuer.publicKey },
      ],
    },
    clock: { wallNow: () => Date.now(), monotonicNow },
    journal,
    driver: router,
    resultTimeoutMs: 5000,
  })
  const active = dispatcher
  cleanup.push(() => active.close())
  const controls =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const caps =
    await import('../../packages/farm-protocol/src/pause-capability.ts')
  const admission = active.beginAdmission({
    binding,
    printerBinding,
    peer: active.createPeer(1).peer,
  })
  const admissionNonce = admission.challenge.admissionNonce
  const admittedAt = Date.now()
  const capability = await caps.signPauseCapability(
    {
      v: 1 as const,
      purpose: 'pause-authority' as const,
      capability_id: ids.capability_id,
      kid: 'issuer-1',
      issuer: 'farm:issuer',
      audience: binding.audience,
      origin: binding.origin,
      issued_at: admittedAt,
      expires_at: binding.expires_at,
      account_id,
      role: 'operator' as const,
      farm_id: ids.farm_id,
      agent_id: ids.agent_id,
      key_id: ids.key_id,
      assignment_id: ids.assignment_id,
      transport_id: ids.transport_id,
      browser_public_key: publicKey,
      browser_thumbprint: thumbprint,
      connector_fingerprint: binding.connector_fingerprint,
      credential_jti: binding.credential_jti,
      printer_key,
      control_binding_sha256: bindingHash,
      admission_nonce: admissionNonce,
      actions: [action],
    },
    issuer.privateKey,
  )
  const proof = await caps.signPauseAdmissionProof(
    {
      v: 1 as const,
      purpose: 'pause-admission' as const,
      challenge_id: randomUUID(),
      farm_id: ids.farm_id,
      agent_id: ids.agent_id,
      key_id: ids.key_id,
      assignment_id: ids.assignment_id,
      transport_id: ids.transport_id,
      account_id,
      browser_thumbprint: thumbprint,
      origin: binding.origin,
      audience: binding.audience,
      control_binding_sha256: bindingHash,
      admission_nonce: admissionNonce,
      issued_at: admittedAt,
      expires_at: admittedAt + 8000,
    },
    pair.privateKey,
  )
  const proofOf = async (role: 'browser' | 'connector', key: CryptoKey) =>
    controls.encodeControlProof({
      v: 1,
      role,
      binding,
      signature: await controls.signControlSessionProof(binding, role, key),
    })
  const accepted = await active.admit(admission.token, {
    capabilityWire: caps.encodePauseCapability(capability),
    admissionProofWire: caps.encodePauseAdmissionProof(proof),
    browserProofWire: await proofOf('browser', pair.privateKey),
    connectorProofWire: await proofOf('connector', connector.privateKey),
  })
  if (!accepted.ok) throw new Error(`not admitted: ${accepted.reason}`)
  const issuedAt = Date.now()
  const signed = await signCommandV2(
    {
      v: 2 as const,
      purpose: 'printer-control' as const,
      cmd_id: randomUUID(),
      ...ids,
      account_id,
      action,
      args,
      issued_at: issuedAt,
      expires_at: issuedAt + 5000,
      nonce: randomBytes(16).toString('base64url'),
    },
    pair.privateKey,
  )
  return {
    remote,
    dispatch: () =>
      active.dispatch({
        wire: encodeCommandV2(signed),
        capability: accepted.handle,
        printerBinding,
      }),
    methods: () => remote.requests.map(({ method }) => method),
  }
}

describe('named fans', () => {
  it('sets a fan_generic and a controller_fan by name with one script', async (t) => {
    for (const [fan, name] of [
      ['exhaust', 'fan_generic'],
      ['electronics', 'controller_fan'],
    ] as const) {
      const f = await world(t, { state: 'standby' }, 'set_fan', {
        fan,
        percent: 50,
      })
      expect(await f.dispatch()).toMatchObject({
        kind: 'outcome-unknown',
        reason: 'state-unconfirmed',
      })
      expect(f.remote.gcodeScripts, name).toEqual([
        `SET_FAN_SPEED FAN=${fan} SPEED=0.5`,
      ])
    }
  })

  it('refuses an unknown fan name before any write', async (t) => {
    const f = await world(t, { state: 'standby' }, 'set_fan', {
      fan: 'nope',
      percent: 50,
    })
    expect(await f.dispatch()).toMatchObject({
      kind: 'not-sent',
      reason: 'unsupported-action',
    })
    expect(f.remote.gcodeScripts).toEqual([])
  })

  it('does not take a name that is a different section type', async () => {
    expect(() =>
      buildMoonrakerCommand(
        'set_fan',
        { fan: 'caselight', percent: 10 },
        OBJECTS,
      ),
    ).toThrow(/unsupported-action/)
    expect(() =>
      buildMoonrakerCommand(
        'set_fan',
        { fan: 'a b\nM112', percent: 10 },
        OBJECTS,
      ),
    ).toThrow()
  })
})

describe('set_led', () => {
  it('sends SET_LED for a listed neopixel with 0-255 channels', async (t) => {
    const f = await world(t, { state: 'standby' }, 'set_led', {
      name: 'chamber_led',
      r: 255,
      g: 0,
      b: 51,
      w: 128,
    })
    await f.dispatch()
    expect(f.remote.gcodeScripts).toEqual([
      'SET_LED LED=chamber_led RED=1 GREEN=0 BLUE=0.2 WHITE=0.502 TRANSMIT=1 SYNC=0',
    ])
  })

  it('omits WHITE for an RGB strip and accepts a plain led', () => {
    expect(
      buildMoonrakerCommand(
        'set_led',
        { name: 'status', r: 0, g: 255, b: 0 },
        OBJECTS,
      ).params,
    ).toEqual({
      script: 'SET_LED LED=status RED=0 GREEN=1 BLUE=0 TRANSMIT=1 SYNC=0',
    })
  })

  it('refuses an unknown LED, without any write', async (t) => {
    const f = await world(t, { state: 'standby' }, 'set_led', {
      name: 'ghost',
      r: 1,
      g: 1,
      b: 1,
    })
    expect(await f.dispatch()).toMatchObject({
      kind: 'not-sent',
      reason: 'unsupported-action',
    })
    expect(f.remote.gcodeScripts).toEqual([])
  })

  it('refuses malformed channels and injected names', () => {
    const bad = [
      { name: 'status', r: 256, g: 0, b: 0 },
      { name: 'status', r: -1, g: 0, b: 0 },
      { name: 'status', r: 1.5, g: 0, b: 0 },
      { name: 'status', r: 0, g: 0 },
      { name: 'status\nM112', r: 0, g: 0, b: 0 },
      { name: 'status', r: 0, g: 0, b: 0, extra: 1 },
    ]
    for (const args of bad) {
      expect(
        ControlArguments.safeParse({ action: 'set_led', args }).success,
      ).toBe(false)
      expect(() => buildMoonrakerCommand('set_led', args, OBJECTS)).toThrow()
    }
  })
})

describe('set_pin', () => {
  it('sends SET_PIN for a listed output_pin', async (t) => {
    const f = await world(t, { state: 'standby' }, 'set_pin', {
      name: 'caselight',
      value: 0.25,
    })
    await f.dispatch()
    expect(f.remote.gcodeScripts).toEqual(['SET_PIN PIN=caselight VALUE=0.25'])
  })

  it('refuses an unknown pin, without any write', async (t) => {
    const f = await world(t, { state: 'standby' }, 'set_pin', {
      name: 'heater_bed',
      value: 1,
    })
    expect(await f.dispatch()).toMatchObject({
      kind: 'not-sent',
      reason: 'unsupported-action',
    })
    expect(f.remote.gcodeScripts).toEqual([])
  })

  it('refuses a value outside 0..1 and an invalid name', () => {
    for (const args of [
      { name: 'psu', value: 1.01 },
      { name: 'psu', value: -0.1 },
      { name: 'psu', value: NaN },
      { name: 'psu; M112', value: 1 },
      { name: 'psu' },
    ])
      expect(
        ControlArguments.safeParse({ action: 'set_pin', args }).success,
      ).toBe(false)
    expect(() =>
      buildMoonrakerCommand('set_pin', { name: 'psu', value: 2 }, OBJECTS),
    ).toThrow(/invalid-command/)
  })

  it('still sends a light change while printing (shared state rule)', async (t) => {
    const f = await world(t, { state: 'printing' }, 'set_pin', {
      name: 'caselight',
      value: 1,
    })
    await f.dispatch()
    expect(f.remote.gcodeScripts).toEqual(['SET_PIN PIN=caselight VALUE=1'])
  })
})

describe('policy and advertisement', () => {
  it('is advertised only when the printer lists a matching object', () => {
    expect(moonrakerControls(OBJECTS)).toEqual(
      expect.arrayContaining(['set_fan', 'set_led', 'set_pin']),
    )
    const none = moonrakerControls(['extruder', 'heater_bed'])
    expect(none).not.toContain('set_led')
    expect(none).not.toContain('set_pin')
    expect(supportedMoonrakerActions(['led status'])).toContain('set_led')
    expect(supportedMoonrakerActions(['output_pin x'])).toContain('set_pin')
    expect(moonrakerControls(undefined)).not.toContain('set_led')
  })

  it('allows operators and above, stays out of the v1 projection', () => {
    for (const action of ['set_led', 'set_pin'] as const) {
      expect(controlRoleAllowed('operator', action)).toBe(true)
      expect(controlRoleAllowed('viewer', action)).toBe(false)
      expect(controlSourceState(action, 'idle')).toBe(true)
      expect(controlSourceState(action, 'error')).toBe(false)
      expect(actionsForControlRole('operator')).not.toContain(action)
      expect(
        controlWithinLimits(action, { name: 'x', r: 0, g: 0, b: 0, value: 0 }),
      ).toBe(false)
    }
  })
})

describe('OutputsPanel', () => {
  const file = '../printer-detail/OutputsPanel.vue'
  const all = { fan: true, led: true, pin: true }

  it('offers the three forms in pt-BR when advertised and enabled', async () => {
    const html = await renderFarmComponent(file, {
      advertised: all,
      canCommand: true,
      fans: ['exhaust'],
    })
    for (const text of [
      'Nome do ventilador',
      'Nome do LED',
      'Nome da saída',
      'Aplicar ao ventilador',
      'Aplicar ao LED',
      'Aplicar à saída',
      'value="exhaust"',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('disabled')
  })

  it('shows only the forms the printer advertises', async () => {
    const html = await renderFarmComponent(file, {
      advertised: { fan: true, led: false, pin: false },
      canCommand: true,
    })
    expect(html).toContain('Nome do ventilador')
    expect(html).not.toContain('Nome do LED')
    expect(html).not.toContain('Nome da saída')
  })

  it('stays visible but off, with the reason, when commands are unavailable', async () => {
    const html = await renderFarmComponent(file, {
      advertised: all,
      canCommand: false,
      disabledReason: 'Comando indisponível. Não há conexão direta ao vivo.',
    })
    expect(html).toContain('Não há conexão direta ao vivo.')
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(9)
  })

  it('shows only the catalog reason when nothing is advertised', async () => {
    const html = await renderFarmComponent(file, {
      advertised: { fan: false, led: false, pin: false },
      canCommand: false,
      disabledReason: 'Saídas indisponíveis nesta família.',
    })
    expect(html).toContain('Saídas indisponíveis nesta família.')
    expect(html).not.toContain('<form')
  })
})
