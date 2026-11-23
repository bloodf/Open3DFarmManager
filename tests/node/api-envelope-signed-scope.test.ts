import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import { receiveApiCommand } from '../../packages/connector/src/runtime/api-command.ts'

test('signed scope cannot be widened by the inbox frame', async () => {
  const key = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const now = Date.now()
  const farm = randomUUID(),
    agent = randomUUID()
  const envelope = await signApiEnvelope(
    {
      v: 1,
      purpose: 'api-envelope',
      issuer: API_ENVELOPE_ISSUER,
      kid: 'test',
      app_id: randomUUID(),
      grant_id: randomUUID(),
      farm_id: farm,
      agent_id: agent,
      assignment_id: randomUUID(),
      resource_id: randomUUID(),
      cmd_id: randomUUID(),
      nonce: newApiEnvelopeNonce(),
      issued_at: now,
      expires_at: now + 60000,
      scope: 'control:basic',
      grant_epoch: now,
      kind: 'action',
      action: {
        action: 'set_temperature',
        args: { heater: 'bed', target_c: 60 },
      },
    },
    key.privateKey,
  )
  const wire = encodeApiEnvelopeFrame({
    v: 1,
    t: 'api-envelope.command',
    envelope,
  })
  const authority = createOfflineAuthority()
  authority.confirm({ wall: now, mono: 1 }, 1)
  let sent = false
  const result = await receiveApiCommand(
    {
      farmId: farm,
      agentId: agent,
      keys: { issuer: () => key.publicKey },
      journal: null as never,
      printer: () => undefined,
      observe: () => null,
      driver: {
        execute: async () => {
          sent = true
          return { acknowledged: true }
        },
      },
      clock: { wallNow: () => now, monotonicNow: () => 1 },
    },
    {
      v: 1,
      t: 'connector.api-command',
      wire,
      scope: 'control:extended',
      confirmed_at: now,
    },
    {
      signal: new AbortController().signal,
      report: () => {},
      freshness: authority.freshness,
    },
  )
  assert.equal(result.kind, 'refused')
  assert.equal(result.kind === 'refused' && result.code, 'grant-revoked')
  assert.match(result.kind === 'refused' ? (result.detail ?? '') : '', /scope/)
  assert.equal(sent, false)
})
