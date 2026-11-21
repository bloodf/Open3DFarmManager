import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createActiveSpoolAssignmentStore } from '../../packages/connector/src/spoolman/active-assignments.ts'

test('concurrent spool assignments for different slots both persist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-assignment-concurrency-'))
  const path = join(dir, 'assignments.json')
  try {
    const store = createActiveSpoolAssignmentStore(path)
    const assignments = Array.from({ length: 32 }, (_, index) => ({
      printerKey: 'printer-a',
      slot: `ams:0:${index}`,
      spoolId: index + 1,
    }))

    await Promise.all(assignments.map((assignment) => store.assign(assignment)))

    const expected = [...assignments].sort((a, b) => a.slot.localeCompare(b.slot))
    assert.deepEqual(
      (await store.list()).sort((a, b) => a.slot.localeCompare(b.slot)),
      expected,
    )
    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      assignments: typeof assignments
    }
    assert.deepEqual(
      persisted.assignments.sort((a, b) => a.slot.localeCompare(b.slot)),
      expected,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
