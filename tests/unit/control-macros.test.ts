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
import { advertisedMoonrakerMacros } from '../../packages/connector/src/control/macro-support.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import {
  buildMacroScript,
  macroParamsAllowed,
  parseMacroParams,
  readMacroParams,
} from '../../packages/connector/src/moonraker/control-macros.ts'
import {
  encodeCommandV2,
  signCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { ControlArguments } from '../../packages/farm-protocol/src/control-actions.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
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
  'gcode_macro PRINT_START',
  'gcode_macro PARK',
  'gcode_macro _PRIVATE',
]
const CONFIG = {
  'gcode_macro PRINT_START': {
    gcode:
      "M140 S{params.BED|default(60)|float}\nM104 S{params.TOOL|default(210)}\nM117 {params['MSG']|default('go')}",
  },
  'gcode_macro PARK': { gcode: 'G28' },
  'gcode_macro _PRIVATE': { gcode: 'M117 {params.SECRET}' },
}
const ARGS = { name: 'PRINT_START', params: { BED: '55', TOOL: '200' } }

type Printer = {
  /** Moonraker print_stats.state reported by the fixture. */
  state: 'standby' | 'printing' | 'paused'
  objects?: readonly string[]
  /** printer.cfg sections returned for the configfile query. */
  config?: Record<string, Record<string, unknown>>
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
  const printer_key = 'printer-macros'
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

  const directory = mkdtempSync(join(tmpdir(), 'control-macros-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  // The configfile read comes from detection; every other query is the
  // prepare read of the print state.
  const remote = await pauseFixture({
    objects: printer.objects ?? OBJECTS,
    query: (index, socket, id) => {
      const asked = remote.requests.at(-1)?.params as
        { objects?: Record<string, unknown> } | undefined
      if (asked?.objects && 'configfile' in asked.objects) {
        reply(socket, id, {
          eventtime: index,
          status: printer.config
            ? { configfile: { config: printer.config } }
            : {},
        })
        return true
      }
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
      role: 'admin' as const,
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
      actions: ['run_macro'],
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
      action: 'run_macro',
      args,
      issued_at: issuedAt,
      expires_at: issuedAt + 5000,
      nonce: randomBytes(16).toString('base64url'),
    },
    pair.privateKey,
  )
  return {
    remote,
    router,
    printerBinding,
    dispatch: () =>
      active.dispatch({
        wire: encodeCommandV2(signed),
        capability: accepted.handle,
        printerBinding,
      }),
    methods: () => remote.requests.map(({ method }) => method),
  }
}

describe('macros with parameters: signed command', () => {
  it('passes the entered parameters as one script', async (t) => {
    const f = await world(t, { state: 'standby', config: CONFIG })
    await f.dispatch()
    expect(f.remote.gcodeScripts).toEqual(['PRINT_START BED=55 TOOL=200'])
  })

  it('still runs a macro without parameters', async (t) => {
    const f = await world(
      t,
      { state: 'standby', config: CONFIG },
      { name: 'PARK' },
    )
    await f.dispatch()
    expect(f.remote.gcodeScripts).toEqual(['PARK'])
  })

  it('refuses a parameter the macro does not read, sending nothing', async (t) => {
    const f = await world(
      t,
      { state: 'standby', config: CONFIG },
      { name: 'PRINT_START', params: { EVIL: '1' } },
    )
    expect(await f.dispatch()).toMatchObject({
      kind: 'rejected',
      reason: 'unsupported-action',
    })
    expect(f.remote.gcodeScripts).toEqual([])
  })

  it('refuses parameters when the config could not be read', async (t) => {
    const f = await world(t, { state: 'standby' })
    expect(await f.dispatch()).toMatchObject({
      kind: 'rejected',
      reason: 'unsupported-action',
    })
    expect(f.remote.gcodeScripts).toEqual([])
  })

  it('refuses parameters for a macro that declares none', async (t) => {
    const f = await world(
      t,
      { state: 'standby', config: CONFIG },
      { name: 'PARK', params: { X: '1' } },
    )
    expect(await f.dispatch()).toMatchObject({
      kind: 'rejected',
      reason: 'unsupported-action',
    })
    expect(f.remote.gcodeScripts).toEqual([])
  })

  it('never signs a command with an unsafe value', async (t) => {
    for (const value of [
      '1\nM112',
      '1;M112',
      'a b',
      'x#',
      'x*',
      '',
      'x'.repeat(65),
    ])
      await expect(
        world(
          t,
          { state: 'standby', config: CONFIG },
          {
            name: 'PRINT_START',
            params: { BED: value },
          },
        ),
      ).rejects.toThrow()
  })

  it('exposes only public macros and their parameters to the state', async (t) => {
    const f = await world(t, { state: 'standby', config: CONFIG })
    expect(f.router.macros?.(f.printerBinding)).toEqual(['PARK', 'PRINT_START'])
    expect(f.router.macroParams?.(f.printerBinding)).toEqual({
      PRINT_START: [
        { name: 'BED', default: '60' },
        { name: 'TOOL', default: '210' },
        { name: 'MSG', default: 'go' },
      ],
    })
  })
})

describe('macro parameter policy', () => {
  const ok = (args: unknown) =>
    ControlArguments.safeParse({ action: 'run_macro', args }).success
  const many = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`P${i}`, String(i)]),
    )

  it('bounds keys, names and values', () => {
    expect(ok({ name: 'A' })).toBe(true)
    expect(ok({ name: 'A', params: {} })).toBe(true)
    expect(ok({ name: 'A', params: many(16) })).toBe(true)
    expect(ok({ name: 'A', params: many(17) })).toBe(false)
    expect(ok({ name: 'A', params: { X: 'x'.repeat(64) } })).toBe(true)
    expect(ok({ name: 'A', params: { X: 'x'.repeat(65) } })).toBe(false)
    for (const value of [
      'a\nb',
      'a\rb',
      'a;b',
      'a b',
      'a\tb',
      'a#b',
      'a*b',
      '',
    ])
      expect(ok({ name: 'A', params: { X: value } })).toBe(false)
    for (const key of ['1X', 'X=1', 'X Y', '_X', '__proto__', 'X;', ''])
      expect(ok({ name: 'A', params: { [key]: '1' } })).toBe(false)
    expect(ok({ name: 'A', params: { X: 1 } })).toBe(false)
    expect(ok({ name: 'A', params: [] })).toBe(false)
    expect(ok({ name: 'A', extra: 1 })).toBe(false)
  })

  it('builds only from validated parts', () => {
    expect(buildMacroScript('A')).toBe('A')
    expect(buildMacroScript('A', { B: '2', A: '1' })).toBe('A A=1 B=2')
    expect(() => buildMacroScript('A', { B: '1;M112' })).toThrow()
    expect(() => buildMacroScript('A B')).toThrow()
    expect(buildMoonrakerCommand('run_macro', ARGS, OBJECTS).params).toEqual({
      script: 'PRINT_START BED=55 TOOL=200',
    })
    expect(() =>
      buildMoonrakerCommand(
        'run_macro',
        { name: 'PARK', params: { X: '1\nM112' } },
        OBJECTS,
      ),
    ).toThrow(/Invalid macro parameters/)
    expect(() =>
      buildMoonrakerCommand('run_macro', { name: 'PARK', other: 1 }, OBJECTS),
    ).toThrow(/Unexpected argument/)
  })

  it('reads uses and defaults from the macro body', () => {
    expect(
      parseMacroParams(
        '{% set a = params.SPEED|default(30) %}{params.SPEED}{params["Q"]}{params.N | default ( \'x\' )}{params.bad-name}',
      ),
    ).toEqual([
      { name: 'SPEED', default: '30' },
      { name: 'Q' },
      { name: 'N', default: 'x' },
      { name: 'bad' },
    ])
    expect(parseMacroParams('G28')).toEqual([])
    // A default that is not a safe literal is dropped, not guessed.
    expect(parseMacroParams('{params.A|default("a b")}')).toEqual([
      { name: 'A' },
    ])
    expect(
      parseMacroParams(
        Array.from({ length: 30 }, (_, i) => `{params.P${i}}`).join(''),
      ),
    ).toHaveLength(16)
  })

  it('hides _-prefixed macros and ignores a malformed config', () => {
    expect(advertisedMoonrakerMacros(OBJECTS)).toEqual(['PARK', 'PRINT_START'])
    const map = readMacroParams(
      { status: { configfile: { config: CONFIG } } },
      ['PRINT_START', '_PRIVATE'],
    )
    expect(Object.keys(map)).toEqual(['PRINT_START'])
    const lower = readMacroParams(
      {
        status: {
          configfile: {
            config: { 'gcode_macro print_start': { gcode: '{params.A}' } },
          },
        },
      },
      ['PRINT_START'],
    )
    expect(lower.PRINT_START).toEqual([{ name: 'A' }])
    for (const bad of [
      undefined,
      {},
      { status: {} },
      { status: { configfile: { config: 1 } } },
    ])
      expect(readMacroParams(bad, ['PRINT_START'])).toEqual({})
  })

  it('allows only declared keys', () => {
    const declared = { A: [{ name: 'X' }] }
    expect(macroParamsAllowed(declared, 'A', undefined)).toBe(true)
    expect(macroParamsAllowed(declared, 'A', { X: '1' })).toBe(true)
    expect(macroParamsAllowed(declared, 'A', { Y: '1' })).toBe(false)
    expect(macroParamsAllowed(declared, 'B', { X: '1' })).toBe(false)
    expect(macroParamsAllowed(undefined, 'A', { X: '1' })).toBe(false)
    expect(macroParamsAllowed(declared, 'A', { X: '1;2' })).toBe(false)
  })

  it('carries parameters in the printer state', () => {
    expect(
      PrinterState.safeParse({
        printerKey: 'p',
        state: 'idle',
        progress: 0,
        observedAt: 1,
        macros: ['A'],
        macroParams: { A: [{ name: 'X', default: '1' }] },
      }).success,
    ).toBe(true)
    expect(
      PrinterState.safeParse({
        printerKey: 'p',
        state: 'idle',
        progress: 0,
        observedAt: 1,
        macroParams: { A: [{ name: 'X;' }] },
      }).success,
    ).toBe(false)
  })
})

describe('MacrosPanel', () => {
  const file = '../printer-detail/MacrosPanel.vue'
  const base = {
    advertised: true,
    canCommand: true,
    macros: [
      { name: 'PRINT_START', params: [{ name: 'BED', default: '60' }] },
      { name: 'PARK', params: [] },
      { name: '_PRIVATE', params: [{ name: 'SECRET' }] },
    ],
  }

  it('shows a parameter form per macro and hides private macros', async () => {
    const html = await renderFarmComponent(file, base)
    for (const text of [
      'Macros',
      'PRINT_START',
      'BED',
      'Padrão: 60',
      'maxlength="64"',
      'Executar PRINT_START',
      'Executar PARK',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('_PRIVATE')
    expect(html).not.toContain('SECRET')
    expect(html).not.toContain('disabled')
  })

  it('stays visible but off, with the reason, when commands are unavailable', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      canCommand: false,
      disabledReason: 'Comando indisponível. Não há conexão direta ao vivo.',
    })
    expect(html).toContain('Não há conexão direta ao vivo.')
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('shows only the reason when the printer does not advertise it', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      advertised: false,
      disabledReason: 'Macros indisponíveis nesta família.',
    })
    expect(html).toContain('Macros indisponíveis nesta família.')
    expect(html).not.toContain('<form')
  })
})
