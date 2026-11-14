import { expect, test } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  UnsignedCommandV2,
  commandV2Payload,
  signCommandV2,
  encodeCommandV2,
  decodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { PauseCapabilityV1 } from '../../packages/farm-protocol/src/pause-capability.ts'
import { controlsForBackend } from '../../packages/farm-protocol/src/control-actions.ts'
import { controlRoleAllowed } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'

const id = () => randomUUID()
const digest = () => randomBytes(32).toString('base64url')
const command = () => ({
  v: 2,
  purpose: 'printer-pause',
  cmd_id: id(),
  farm_id: id(),
  agent_id: id(),
  account_id: 'operator',
  key_id: id(),
  transport_id: id(),
  capability_id: id(),
  assignment_id: id(),
  action: 'pause',
  args: {},
  issued_at: 1000,
  expires_at: 6000,
  nonce: randomBytes(16).toString('base64url'),
})

test('pause retains its exact canonical signing payload', () => {
  const input = command()
  expect(UnsignedCommandV2.parse(input)).toEqual(input)
  expect(new TextDecoder().decode(commandV2Payload(input))).toBe(
    'Open3DFarmManager/printer-command/v2\0' + canonicalize(input),
  )
})

test.each(['resume', 'cancel'])(
  '%s uses printer-control and round trips signed frames',
  async (action) => {
    const input = { ...command(), action, purpose: 'printer-control' }
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const signed = await signCommandV2(input, pair.privateKey)
    expect(decodeCommandV2(encodeCommandV2(signed))).toEqual(signed)
    expect(
      UnsignedCommandV2.safeParse({ ...input, purpose: 'printer-pause' })
        .success,
    ).toBe(false)
  },
)

test('purpose/action combinations and unknown actions fail closed', () => {
  expect(
    UnsignedCommandV2.safeParse({ ...command(), purpose: 'printer-control' })
      .success,
  ).toBe(false)
  expect(
    UnsignedCommandV2.safeParse({ ...command(), action: 'start' }).success,
  ).toBe(false)
})

test('capabilities carry bounded unique allowed actions and approved roles', () => {
  const capability = {
    v: 1,
    purpose: 'pause-authority',
    capability_id: id(),
    kid: 'issuer-1',
    issuer: 'farm:issuer',
    audience: 'open3dfarmmanager:pause',
    origin: 'https://farm.example',
    issued_at: 1000,
    expires_at: 31000,
    account_id: 'operator',
    role: 'operator',
    farm_id: id(),
    agent_id: id(),
    key_id: id(),
    assignment_id: id(),
    transport_id: id(),
    browser_public_key: { kty: 'EC', crv: 'P-256', x: digest(), y: digest() },
    browser_thumbprint: digest(),
    connector_fingerprint: 'SHA256:' + digest(),
    credential_jti: id(),
    printer_key: 'printer',
    control_binding_sha256: digest(),
    admission_nonce: digest(),
    actions: ['pause', 'resume', 'cancel'],
  }
  expect(PauseCapabilityV1.parse(capability).actions).toEqual([
    'pause',
    'resume',
    'cancel',
  ])
  for (const actions of [[], ['start'], ['pause', 'pause']])
    expect(
      PauseCapabilityV1.safeParse({ ...capability, actions }).success,
    ).toBe(false)
  for (const role of ['owner', 'admin', 'operator']) {
    expect(controlRoleAllowed(role)).toBe(true)
    expect(PauseCapabilityV1.safeParse({ ...capability, role }).success).toBe(
      true,
    )
  }
  for (const role of ['viewer', 'guest', '']) {
    expect(controlRoleAllowed(role)).toBe(false)
    expect(PauseCapabilityV1.safeParse({ ...capability, role }).success).toBe(
      false,
    )
  }
})

test('snapshots expose backend controls and strip untrusted advertised controls', () => {
  const agentId = id()
  const refs = ['moonraker', 'kobralink', 'bambu'].map((printerKey) => ({
    assignmentId: id(),
    agentId,
    printerKey,
  }))
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    nowMono: () => 100,
  })
  const base = { epoch: 1, receivedAtMonoMs: 100 }
  const times = { webhooks: 100, printState: 100, progress: 100 }
  for (const backend of ['moonraker', 'kobralink', 'bambu'])
    source.observe({
      ...base,
      printerKey: backend,
      printer: {
        printerKey: backend,
        state: 'printing',
        progress: 0.5,
        observedAt: 100,
        controls: ['cancel'],
      },
      fieldObservedAtMonoMs:
        backend === 'bambu' ? { bambu: { state: 100, progress: 100 } } : times,
      ...(backend === 'moonraker'
        ? {
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: 'printing' },
              virtual_sdcard: { progress: 0.5 },
            },
          }
        : {}),
    })
  const binding: Parameters<FarmSnapshotProvider>[0]['binding'] = {
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: id(),
    farm_id: id(),
    agent_id: agentId,
    account_id: 'operator',
    key_id: id(),
    browser_public_key: { kty: 'EC', crv: 'P-256', x: digest(), y: digest() },
    browser_thumbprint: digest(),
    connector_public_key_spki: 'test',
    connector_fingerprint: 'test',
    credential_jti: id(),
    origin: 'https://farm.example',
    audience: 'test',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: 0,
    expires_at: 10000,
    commands_enabled: false,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: 'test',
    connector_dtls: 'test',
  }
  let received: CompleteFarmSnapshot | undefined
  const controller = new AbortController()
  try {
    source.open({
      binding,
      assignmentRefs: refs,
      signal: controller.signal,
      deadlineMonoMs: 1000,
      onComplete(value) {
        received = value
      },
      onUnavailable() {},
    })
    expect(received?.printers.map((printer) => printer.controls)).toEqual([
      ['pause', 'resume', 'cancel'],
      [],
      [],
    ])
    expect(controlsForBackend('unknown')).toEqual([])
    expect(
      PrinterState.safeParse({
        printerKey: 'p',
        state: 'idle',
        progress: 0,
        observedAt: 0,
      }).success,
    ).toBe(true)
  } finally {
    controller.abort()
    source.close()
  }
})
