import { expect, it } from 'vitest'
import { controlSourceState } from '../../packages/farm-protocol/src/control-actions.ts'

it.each([
  ['printing', true, false, true],
  ['paused', true, false, true],
  ['idle', true, true, true],
  ['error', true, true, false],
  ['unknown', true, false, false],
  ['complete', true, false, true],
  ['cancelled', true, false, true],
] as const)('control actions in %s', (state, stop, restart, temperature) => {
  expect(controlSourceState('emergency_stop', state)).toBe(stop)
  expect(controlSourceState('firmware_restart', state)).toBe(restart)
  expect(controlSourceState('set_temperature', state)).toBe(temperature)
})

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openCommandJournal,
  closeCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'

it('migrates the lifecycle journal and preserves recorded actions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'estop-migration-'))
  try {
    closeCommandJournal(openCommandJournal({ directory, clock: Date.now }))
    const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      db.exec(
        "DROP INDEX pause_active_assignment; DROP INDEX pause_active_printer; CREATE UNIQUE INDEX pause_active_assignment ON pause_commands(assignment_id) WHERE status IN ('claimed','write-started','outcome-unknown'); CREATE UNIQUE INDEX pause_active_printer ON pause_commands(farm_id,printer_key) WHERE status IN ('claimed','write-started','outcome-unknown'); DROP TABLE control_command_restarts; DROP TABLE control_tool_temperature_args;DROP TABLE control_command_actions; CREATE TABLE control_command_actions (cmd_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('pause','resume','cancel'))) STRICT; INSERT INTO control_command_actions VALUES ('existing', 'pause'); PRAGMA user_version=2;",
      )
    } finally {
      db.close()
    }
    const journal = openCommandJournal({ directory, clock: Date.now })
    try {
      expect(readCommandAction(journal, 'existing')).toBe('pause')
    } finally {
      closeCommandJournal(journal)
    }
    const migrated = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      migrated.exec(
        "INSERT INTO control_command_actions VALUES ('stop', 'emergency_stop')",
      )
      expect(() =>
        migrated.exec(
          "INSERT INTO control_command_actions VALUES ('invalid', 'invalid')",
        ),
      ).toThrow()
    } finally {
      migrated.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
