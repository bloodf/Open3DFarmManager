import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'

const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const agentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const scope = { farmId, agentId }
const ref = (assignmentId = first, printerKey = 'printer') => ({
  assignmentId,
  agentId,
  printerKey,
})

test('literal canonical scoped vector, UUID case and permutation', async () => {
  const expected =
    '{"agent_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","assignments":[{"assignment_id":"11111111-1111-4111-8111-111111111111","printer_key":"printer"}],"domain":"open3dfarmmanager:rtc-assignment-set:v1","farm_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","v":1}'
  assert.deepEqual(await assignmentSetDigest(scope, [ref()]), {
    count: 1,
    digest: createHash('sha256').update(expected).digest('base64url'),
  })
  assert.deepEqual(
    await assignmentSetDigest(
      { farmId: farmId.toUpperCase(), agentId: agentId.toUpperCase() },
      [ref()],
    ),
    await assignmentSetDigest(scope, [ref()]),
  )
  assert.deepEqual(
    await assignmentSetDigest(scope, [ref(first, 'a'), ref(second, 'b')]),
    await assignmentSetDigest(scope, [ref(second, 'b'), ref(first, 'a')]),
  )
  assert.notDeepEqual(
    await assignmentSetDigest(scope, [ref(first)]),
    await assignmentSetDigest(scope, [ref(second)]),
  )
  assert.notDeepEqual(
    await assignmentSetDigest(scope, [ref()]),
    await assignmentSetDigest({ farmId: agentId, agentId }, [ref()]),
  )
  assert.notDeepEqual(
    await assignmentSetDigest(scope, [ref(first, '\u00e9')]),
    await assignmentSetDigest(scope, [ref(first, 'e\u0301')]),
  )
})

test('scope, exact keys, strict tuples, count and PostgreSQL UTF8 failures', async () => {
  for (const refs of [
    [],
    [ref(), ref()],
    [ref(first), ref(second)],
    [{ ...ref(), agentId: farmId }],
    [ref(first, '\0')],
    [ref(first, '\ud800')],
    [ref(first, '\udfff')],
    [ref(first, '')],
    [ref(first, 'a'.repeat(129))],
    [{ ...ref(), extra: true }],
  ])
    await assert.rejects(assignmentSetDigest(scope, refs))
  await assert.rejects(
    assignmentSetDigest(
      scope,
      Array.from({ length: 17 }, (_, i) =>
        ref(
          `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
          String(i),
        ),
      ),
    ),
  )
})

test('worst escaped sixteen-key shape fits the canonical input cap', async () => {
  const refs = Array.from({ length: 16 }, (_, i) =>
    ref(
      `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      '\u0001'.repeat(127) + String.fromCharCode(i + 1),
    ),
  )
  const result = await assignmentSetDigest(scope, refs)
  assert.equal(result.count, 16)
  assert.match(result.digest, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
})
