import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'

test('a newer journal is refused without changing its version', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-939-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: () => 100_000 })
  closeCommandJournal(journal)
  const path = join(directory, 'pause-commands.sqlite')
  const database = new DatabaseSync(path)
  database.exec('PRAGMA user_version=21')
  database.close()
  assert.throws(
    () => openCommandJournal({ directory, clock: () => 100_000 }),
    /Unknown command journal version/,
  )
  const reopened = new DatabaseSync(path)
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 21)
  reopened.close()
})
