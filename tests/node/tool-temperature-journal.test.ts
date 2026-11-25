import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  claimCommand,
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'

test('v17 journal upgrades and retains prior actions; tool claims persist exact arguments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tool-journal-'))
  const path = join(directory, 'pause-commands.sqlite')
  let journal = openCommandJournal({ directory, clock: () => 1000 })
  closeCommandJournal(journal)
  const db = new DatabaseSync(path)
  // Derive the precise shipped schema from the new action table, removing only the new action.
  const sql = String(
    db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='control_command_actions'",
      )
      .get()!.sql,
  ).replace(",'set_tool_temperature'", '')
  db.exec(
    `DROP TABLE control_tool_temperature_args; DROP TABLE control_command_actions; ${sql}; INSERT INTO control_command_actions VALUES('retained','pause'); PRAGMA user_version=17`,
  )
  db.close()
  try {
    journal = openCommandJournal({ directory, clock: () => 1000 })
    const migrated = new DatabaseSync(path)
    assert.equal(
      migrated
        .prepare(
          "SELECT action FROM control_command_actions WHERE cmd_id='retained'",
        )
        .get()?.action,
      'pause',
    )
    migrated.close()
    const command = {
      v: 2 as const,
      purpose: 'printer-control' as const,
      cmd_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      account_id: 'text_account',
      key_id: randomUUID(),
      transport_id: randomUUID(),
      capability_id: randomUUID(),
      assignment_id: randomUUID(),
      action: 'set_tool_temperature' as const,
      args: { tool: 2 as const, target_c: 215 },
      issued_at: 1000,
      expires_at: 6000,
      nonce: randomBytes(16).toString('base64url'),
      sig: 'A'.repeat(86),
    }
    assert.equal(
      claimCommand(journal, {
        command,
        printerKey: 'fake',
        wireSha256: 'a'.repeat(64),
      }).ok,
      true,
    )
    closeCommandJournal(journal)
    const read = new DatabaseSync(path)
    try {
      assert.deepEqual(
        {
          ...read
            .prepare(
              'SELECT action FROM control_command_actions WHERE cmd_id=?',
            )
            .get(command.cmd_id),
        },
        { action: 'set_tool_temperature' },
      )
      assert.deepEqual(
        {
          ...read
            .prepare(
              'SELECT tool,target_c FROM control_tool_temperature_args WHERE cmd_id=?',
            )
            .get(command.cmd_id),
        },
        { tool: 2, target_c: 215 },
      )
      assert.equal(read.prepare('PRAGMA user_version').get()?.user_version, 18)
    } finally {
      read.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
