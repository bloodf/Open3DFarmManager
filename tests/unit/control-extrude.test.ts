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
const OBJECTS = ['extruder', 'extruder1', 'heater_bed']
const ARGS = { tool: 0, length_mm: 10, feed: 300 }

type Printer = {
  /** Moonraker print_stats.state reported by the fixture. */
  state: 'standby' | 'printing' | 'paused'
  /** Klipper can_extrude: temperature at or above min_extrude_temp. */
  canExtrude?: boolean | 'malformed'
  objects?: readonly string[]
}

const reply = (socket: WebSocket, id: number, result: unknown) =>
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))

async function world(
  t: TestContext,
  printer: Printer,
  args: Record<string, unknown> = ARGS,
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
  const printer_key = 'printer-extrude'
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

  const directory = mkdtempSync(join(tmpdir(), 'control-extrude-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  // Query 1 is the prepare read, 2 the extrusion probe, 3 the result audit.
  const remote = await pauseFixture({
    objects: printer.objects ?? OBJECTS,
    query: (index, socket, id) => {
      if (index === 2)
        reply(
          socket,
          id,
          printer.canExtrude === 'malformed'
            ? { status: {} }
            : {
                eventtime: index,
                status: Object.fromEntries(
                  ['extruder', 'extruder1'].map((name) => [
                    name,
                    {
                      temperature: printer.canExtrude === false ? 20 : 210,
                      can_extrude: printer.canExtrude !== false,
                    },
                  ]),
                ),
              },
        )
      else
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
      actions: ['extrude'],
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
      action: 'extrude',
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

const SCRIPT = (select: string, move: string) =>
  [
    select,
    'SAVE_GCODE_STATE NAME=OPENFARM_EXTRUDE',
    'M83',
    move,
    'RESTORE_GCODE_STATE NAME=OPENFARM_EXTRUDE',
  ].join('\n')

describe('extrude: signed command', () => {
  it('selects the tool, uses M83 and sends exactly one script when idle and hot', async (t) => {
    const f = await world(t, { state: 'standby' })
    const result = await f.dispatch()
    // Moonraker extended actions carry no state effect to confirm.
    expect(result).toMatchObject({
      kind: 'outcome-unknown',
      reason: 'state-unconfirmed',
    })
    expect(f.remote.gcodeScripts).toEqual([
      SCRIPT('ACTIVATE_EXTRUDER EXTRUDER=extruder', 'G1 E10 F300'),
    ])
  })

  it('retracts with a negative length on a later tool', async (t) => {
    const f = await world(
      t,
      { state: 'standby' },
      {
        tool: 1,
        length_mm: -5.5,
        feed: 600,
      },
    )
    await f.dispatch()
    expect(f.remote.gcodeScripts).toEqual([
      SCRIPT('ACTIVATE_EXTRUDER EXTRUDER=extruder1', 'G1 E-5.5 F600'),
    ])
  })

  it('prefers a printer T macro to select the tool', async (t) => {
    const f = await world(t, {
      state: 'standby',
      objects: [...OBJECTS, 'gcode_macro T0'],
    })
    await f.dispatch()
    expect(f.remote.gcodeScripts).toEqual([SCRIPT('T0', 'G1 E10 F300')])
  })
})

describe('extrude: refusals send no G-code', () => {
  it('refuses a cold tool below min_extrude_temp', async (t) => {
    const f = await world(t, { state: 'standby', canExtrude: false })
    expect(await f.dispatch()).toMatchObject({
      kind: 'not-sent',
      reason: 'state',
    })
    expect(f.remote.gcodeScripts).toEqual([])
    expect(f.methods()).not.toContain('printer.gcode.script')
  })

  it('refuses an unreadable temperature report', async (t) => {
    const f = await world(t, { state: 'standby', canExtrude: 'malformed' })
    expect(await f.dispatch()).toMatchObject({
      kind: 'not-sent',
      reason: 'state',
    })
    expect(f.remote.gcodeScripts).toEqual([])
  })

  for (const state of ['printing', 'paused'] as const)
    it(`refuses while ${state}, before reading the tool`, async (t) => {
      const f = await world(t, { state })
      expect(await f.dispatch()).toMatchObject({
        kind: 'not-sent',
        reason: 'state',
      })
      expect(f.remote.gcodeScripts).toEqual([])
      // Only the prepare read happened; the probe never ran.
      expect(f.remote.counts().queries).toBe(1)
    })

  it('refuses an unknown tool', async (t) => {
    const f = await world(t, { state: 'standby' }, { ...ARGS, tool: 2 })
    expect(await f.dispatch()).toMatchObject({
      kind: 'not-sent',
      reason: 'unsupported-action',
    })
    expect(f.remote.gcodeScripts).toEqual([])
  })
})

describe('extrude: policy', () => {
  it('validates length, tool and feed bounds', () => {
    const ok = (args: unknown) =>
      ControlArguments.safeParse({ action: 'extrude', args }).success
    expect(ok(ARGS)).toBe(true)
    expect(ok({ ...ARGS, length_mm: -50 })).toBe(true)
    expect(ok({ ...ARGS, length_mm: 100 })).toBe(true)
    expect(controlWithinLimits('extrude', { ...ARGS, length_mm: 101 })).toBe(
      false,
    )
    expect(controlWithinLimits('extrude', ARGS)).toBe(true)
    for (const length_mm of [-50.1, 100.1, 0, NaN, Infinity])
      expect(ok({ ...ARGS, length_mm })).toBe(false)
    for (const patch of [
      { tool: -1 },
      { tool: 1.5 },
      { feed: 0 },
      { feed: 6001 },
      { extra: 1 },
    ])
      expect(ok({ ...ARGS, ...patch })).toBe(false)
  })

  it('allows operators and above, only while stopped', () => {
    for (const role of ['operator', 'admin', 'owner'])
      expect(controlRoleAllowed(role, 'extrude')).toBe(true)
    expect(controlRoleAllowed('viewer', 'extrude')).toBe(false)
    expect(
      ['idle', 'cancelled'].every((state) =>
        controlSourceState('extrude', state),
      ),
    ).toBe(true)
    for (const state of ['printing', 'paused', 'error', 'unknown', 'offline'])
      expect(controlSourceState('extrude', state)).toBe(false)
  })

  it('is advertised only with a detected extruder and stays out of the v1 projection', () => {
    expect(moonrakerControls(['extruder'])).toContain('extrude')
    expect(moonrakerControls(['heater_bed'])).not.toContain('extrude')
    expect(moonrakerControls(undefined)).not.toContain('extrude')
    expect(supportedMoonrakerActions(['extruder'])).toContain('extrude')
    expect(actionsForControlRole('operator')).not.toContain('extrude')
  })

  it('builds only from validated numbers and a listed tool', () => {
    expect(() =>
      buildMoonrakerCommand('extrude', { ...ARGS, tool: 1 }, ['extruder']),
    ).toThrow(/unsupported-action/)
    expect(() =>
      buildMoonrakerCommand('extrude', { ...ARGS, feed: '1\nM112' }, OBJECTS),
    ).toThrow(/invalid-command/)
  })
})

describe('ExtrusionPanel', () => {
  const file = '../printer-detail/ExtrusionPanel.vue'
  const base = { advertised: true, tools: [0, 1], canCommand: true }

  it('offers tools, length, feed and both directions when enabled', async () => {
    const html = await renderFarmComponent(file, base)
    for (const text of [
      'Extrusão',
      'Ferramenta 1',
      'Ferramenta 2',
      'Comprimento (mm)',
      'Velocidade (mm/min)',
      'Extrudar',
      'Retrair',
      'max="100"',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('disabled')
  })

  it('stays visible but off, with the reason, when commands are unavailable', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      canCommand: false,
      disabledReason: 'Comando indisponível. Não há conexão direta ao vivo.',
    })
    expect(html).toContain('Não há conexão direta ao vivo.')
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('shows only the reason when the printer does not advertise it', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      advertised: false,
      disabledReason: 'Extrusão indisponível nesta família.',
    })
    expect(html).toContain('Extrusão indisponível nesta família.')
    expect(html).not.toContain('<form')
  })
})
