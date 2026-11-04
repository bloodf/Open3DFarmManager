import { expect, test } from 'bun:test'
import {
  AgentSync,
  AgentSyncResponse,
  SignedCommand,
  Signalling,
  StatusMessage,
  CommandAck,
} from '@open3dfarmmanager/farm-protocol'
const id = '00000000-0000-4000-8000-000000000001'
const command = {
  v: 1 as const,
  cmd_id: id,
  farm_id: id,
  agent_id: id,
  printer_id: id,
  user_id: id,
  key_id: id,
  action: 'pause' as const,
  args: {},
  issued_at: 1000,
  expires_at: 61000,
  nonce: 'a'.repeat(22),
  sig: 'a'.repeat(86),
}
test('command JSON round-trip only checks shape, not cryptographic validity', () => {
  expect(SignedCommand.parse(JSON.parse(JSON.stringify(command)))).toEqual(
    command,
  )
})
test.each([
  { expires_at: 1000 },
  { expires_at: 61001 },
  { action: 'gcode' },
  { args: { script: 'M112' } },
  { sig: 'invalid' },
  { extra: true },
])('reject invalid command %p', (patch) => {
  expect(SignedCommand.safeParse({ ...command, ...patch }).success).toBe(false)
})
test('signalling rejects commands and oversized SDP', () => {
  const offer = {
    id,
    ts: 1,
    t: 'rtc.offer' as const,
    p: { agent_id: id, viewer_id: id, sdp: 'v=0' },
  }
  expect(Signalling.parse(offer)).toEqual(offer)
  expect(
    Signalling.safeParse({ ...offer, p: { ...offer.p, sdp: 'a'.repeat(7001) } })
      .success,
  ).toBe(false)
  expect(
    Signalling.safeParse({ id, ts: 1, t: 'command', p: command }).success,
  ).toBe(false)
})
test('HTTP sync rejects control payloads in both directions', () => {
  expect(
    AgentSync.parse({ agents_seq: 1, printers: [], queue_depth: 0 })
      .queue_depth,
  ).toBe(0)
  expect(
    AgentSync.safeParse({
      agents_seq: 1,
      printers: [],
      queue_depth: 0,
      command,
    }).success,
  ).toBe(false)
  expect(
    AgentSyncResponse.safeParse({ snapshot_cadence_s: 120, command }).success,
  ).toBe(false)
})
test('status and acknowledgement payloads round-trip', () => {
  expect(StatusMessage.parse({ t: 'snapshot', seq: 1, printers: [] })).toEqual({
    t: 'snapshot',
    seq: 1,
    printers: [],
  })
  expect(
    CommandAck.parse({ t: 'ack', cmd_id: id, ok: false, error: 'expired' }).ok,
  ).toBe(false)
})
