import assert from 'node:assert/strict'
import test from 'node:test'
import type { TransactionSql } from 'postgres'
import {
  readAcceptanceCredentialRecords,
  readSignallingCredentialRecords,
  readPauseNegotiationCredentialRecords,
  readPauseAuthorityCredentialRecords,
  readRevocationCredentialRecords,
} from '../../apps/farm/server/storage/postgres-connector-credential-record.ts'

const agentId = '12345678-1234-4234-8234-123456789abc'
const jti = '22345678-1234-4234-8234-123456789abc'
const identity = {
  jti,
  farm_id: '32345678-1234-4234-8234-123456789abc',
  fingerprint: 'SHA256:' + 'A'.repeat(43),
  thumbprint: 'A'.repeat(43),
  issuer: 'https://farm.example',
  audience: 'connector',
  issued_at: 8_639_999_999_000,
  expires_at: 8_640_000_000_000,
}
const acceptance = { ...identity, agent_id: agentId, kid: 'key_1' }
const revocation = {
  jti,
  farm_id: identity.farm_id,
  fingerprint: identity.fingerprint,
}

function transaction(rows: readonly object[]) {
  const calls: { text: string; values: unknown[] }[] = []
  const tag = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: parts.join('?'), values })
    return structuredClone(rows)
  }
  // Deliberate tagged-SQL boundary double, not a database lock/privilege proof.
  return { tx: tag as unknown as TransactionSql, calls }
}

const cases = [
  {
    name: 'acceptance retains the ten-column agent SHARE lookup',
    read: (tx: TransactionSql) => readAcceptanceCredentialRecords(tx, agentId),
    row: acceptance,
    text: 'SELECT jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at::float8,expires_at::float8 FROM farm.connector_credentials WHERE agent_id=?::uuid FOR SHARE',
    values: [agentId],
  },
  {
    name: 'signalling retains the eight-column agent SHARE lookup',
    read: (tx: TransactionSql) =>
      readSignallingCredentialRecords(tx, agentId),
    row: identity,
    text: 'SELECT jti, farm_id, fingerprint, thumbprint, issuer, audience, issued_at::float8 AS issued_at, expires_at::float8 AS expires_at FROM farm.connector_credentials WHERE agent_id = ?::uuid FOR SHARE',
    values: [agentId],
  },
  {
    name: 'pause negotiation retains the eight-column agent UPDATE lookup',
    read: (tx: TransactionSql) =>
      readPauseNegotiationCredentialRecords(tx, agentId),
    row: identity,
    text: 'SELECT jti,farm_id,fingerprint,thumbprint,issuer,audience,issued_at::float8 AS issued_at,expires_at::float8 AS expires_at FROM farm.connector_credentials WHERE agent_id=?::uuid FOR UPDATE',
    values: [agentId],
  },
  {
    name: 'pause authority retains both binding predicates and UPDATE lock',
    read: (tx: TransactionSql) =>
      readPauseAuthorityCredentialRecords(tx, agentId, jti),
    row: identity,
    text: 'SELECT jti,farm_id,fingerprint,thumbprint,issuer,audience,issued_at::float8 AS issued_at,expires_at::float8 AS expires_at FROM farm.connector_credentials WHERE jti=?::uuid AND agent_id=?::uuid FOR UPDATE',
    values: [jti, agentId],
  },
  {
    name: 'revocation retains only its three root metadata columns',
    read: (tx: TransactionSql) => readRevocationCredentialRecords(tx, agentId),
    row: revocation,
    text: 'SELECT jti, farm_id, fingerprint FROM farm.connector_credentials WHERE agent_id = ?::uuid FOR SHARE',
    values: [agentId],
  },
]

for (const entry of cases) {
  test(entry.name, async () => {
    const f = transaction([entry.row])
    assert.deepEqual(await entry.read(f.tx), [entry.row])
    assert.deepEqual(f.calls, [{ text: entry.text, values: entry.values }])
    const absent = transaction([])
    const records = await entry.read(absent.tx)
    assert.deepEqual(records, [])
    assert.equal(records[0] ?? null, null)
    assert.deepEqual(absent.calls, [{ text: entry.text, values: entry.values }])
  })
}

test('metadata lookup does not introduce parsing, normalization or live-authority decisions', async () => {
  // PostgreSQL length counts characters, not UTF-16 units. UUID metadata is
  // not restricted to the protocol's UUID versions by the immutable table.
  const stored = {
    ...acceptance,
    jti: '00000000-0000-0000-0000-000000000000',
    issuer: '🖨'.repeat(256),
    audience: 'é'.repeat(256),
    issued_at: 0,
    expires_at: 1,
  }
  const f = transaction([stored])
  assert.deepEqual(await readAcceptanceCredentialRecords(f.tx, agentId), [stored])
  assert.equal(f.calls.length, 1)
})

test('storage failures propagate to the existing caller transaction handlers', async () => {
  const failure = new Error('connection lost')
  const tag = async () => {
    throw failure
  }
  for (const entry of cases)
    await assert.rejects(
      entry.read(tag as unknown as TransactionSql),
      (error) => error === failure,
    )
})
