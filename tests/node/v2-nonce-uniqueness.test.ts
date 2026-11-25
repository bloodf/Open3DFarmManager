import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  openCommandJournal,
  claimCommand,
  markWriteStarted,
  finishCommand,
  closeCommandJournal,
  type CommandJournalHandle,
} from '../../packages/connector/src/control/command-journal.ts'

const legacyActions = `CREATE TABLE control_command_actions (cmd_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('pause','resume','cancel'))) STRICT`

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'open3dfarm-nonce-journal-'))
  let now = 1000
  const clock = () => now
  const keyId = randomUUID()
  const scope = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'text_account',
    transport_id: randomUUID(),
    capability_id: randomUUID(),
  }
  const command = (patch: Record<string, unknown> = {}) => ({
    v: 2 as const,
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    ...scope,
    key_id: keyId,
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: 1000,
    expires_at: 6000,
    nonce: randomBytes(16).toString('base64url'),
    sig: 'A'.repeat(86),
    ...patch,
  })
  const claim = (
    journal: CommandJournalHandle,
    value = command(),
    printerKey = 'printer-1',
  ) =>
    claimCommand(journal, {
      command: value,
      printerKey,
      wireSha256: randomBytes(32).toString('hex'),
    })
  const settle = (journal: CommandJournalHandle, value = command()) => {
    const first = claim(journal, value)
    assert.ok(first.ok)
    assert.equal(markWriteStarted(journal, first.receipt), true)
    assert.equal(
      finishCommand(journal, first.receipt, 'applied', 'applied'),
      true,
    )
    return value
  }
  return {
    directory,
    clock,
    command,
    claim,
    settle,
    open: () => openCommandJournal({ directory, clock }),
    setNow: (n: number) => {
      now = n
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

test('a nonce reused with a new cmd_id is rejected as replay, for settled and unresolved rows', () => {
  const f = fixture()
  const journal = f.open()
  try {
    const settled = f.settle(journal)
    assert.deepEqual(f.claim(journal, f.command({ nonce: settled.nonce })), {
      ok: false,
      reason: 'replay',
    })
    const open = f.command({ assignment_id: randomUUID() })
    assert.ok(f.claim(journal, open, 'printer-2').ok)
    assert.deepEqual(
      f.claim(journal, f.command({ nonce: open.nonce }), 'printer-3'),
      { ok: false, reason: 'replay' },
    )
    // Same nonce under another key is a different identity.
    assert.ok(
      f.claim(
        journal,
        f.command({ nonce: settled.nonce, key_id: randomUUID() }),
        'printer-4',
      ).ok,
    )
  } finally {
    closeCommandJournal(journal)
    f.cleanup()
  }
})

test('the nonce rejection survives a journal reopen and ends with applied-command retention', () => {
  const f = fixture()
  let journal = f.open()
  try {
    const settled = f.settle(journal)
    closeCommandJournal(journal)
    journal = f.open()
    f.setNow(2000)
    assert.deepEqual(
      f.claim(
        journal,
        f.command({ nonce: settled.nonce, issued_at: 2000, expires_at: 7000 }),
      ),
      { ok: false, reason: 'replay' },
    )
    f.setNow(1000 + 600_000 + 1)
    assert.ok(
      f.claim(
        journal,
        f.command({
          nonce: settled.nonce,
          issued_at: 601_001,
          expires_at: 606_000,
        }),
      ).ok,
    )
  } finally {
    closeCommandJournal(journal)
    f.cleanup()
  }
})

for (const version of [1, 2, 3]) {
  test(`a v${version} journal file migrates and still enforces nonce uniqueness`, () => {
    const f = fixture()
    let journal = f.open()
    try {
      const settled = f.settle(journal)
      closeCommandJournal(journal)
      // Rewind the file to an older schema generation.
      const raw = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
      raw.exec(`
        DROP INDEX pause_active_assignment;
        DROP INDEX pause_active_printer;
        CREATE UNIQUE INDEX pause_active_assignment ON pause_commands(assignment_id) WHERE status IN ('claimed','write-started','outcome-unknown');
        CREATE UNIQUE INDEX pause_active_printer ON pause_commands(farm_id,printer_key) WHERE status IN ('claimed','write-started','outcome-unknown');
        DROP TABLE control_command_restarts; DROP TABLE control_tool_temperature_args;DROP TABLE control_command_actions;
      `)
      if (version !== 1) {
        raw.exec(
          version === 2
            ? legacyActions
            : legacyActions.replace(
                "'pause','resume','cancel'",
                "'pause','resume','cancel','emergency_stop','firmware_restart','set_temperature','set_fan','home','set_light','set_speed','start_print'",
              ),
        )
        raw.exec(
          `INSERT INTO control_command_actions VALUES('${settled.cmd_id}','pause')`,
        )
      }
      raw.exec(`PRAGMA user_version=${version}`)
      raw.close()
      journal = f.open()
      f.setNow(2000)
      assert.deepEqual(
        f.claim(
          journal,
          f.command({
            nonce: settled.nonce,
            issued_at: 2000,
            expires_at: 7000,
          }),
        ),
        { ok: false, reason: 'replay' },
      )
    } finally {
      closeCommandJournal(journal)
      f.cleanup()
    }
  })
}

test('a journal file missing the (key_id, nonce) unique constraint is refused', () => {
  const f = fixture()
  const journal = f.open()
  closeCommandJournal(journal)
  try {
    const raw = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
    const sql = String(
      raw
        .prepare("SELECT sql FROM sqlite_schema WHERE name='pause_commands'")
        .get()?.sql,
    )
    raw.enableDefensive(false)
    raw.exec('PRAGMA writable_schema=ON')
    raw
      .prepare("UPDATE sqlite_schema SET sql=? WHERE name='pause_commands'")
      .run(sql.replace('UNIQUE(key_id,nonce),', ''))
    raw.close()
    assert.throws(() => f.open(), /schema|Invalid command journal/i)
  } finally {
    f.cleanup()
  }
})
