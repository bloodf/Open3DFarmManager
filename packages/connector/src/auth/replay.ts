import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, lstatSync, openSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SignedCommand } from '@open3dfarmmanager/farm-protocol'
import type { ClaimResult, ReplayStore } from './verify.ts'

function privateEntry(path: string, directory: boolean) {
  const stat = lstatSync(path)
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error('Replay storage must use regular private files')
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  )
    throw new Error(
      'Replay storage must be owned by the current user and private',
    )
}

export class PersistentReplayStore implements ReplayStore {
  private readonly database: DatabaseSync
  private readonly capacity: number
  constructor(directory: string, capacity = 10_000) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100_000)
      throw new Error('Invalid replay capacity')
    this.capacity = capacity
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    privateEntry(directory, true)
    const path = join(directory, 'replay.sqlite')
    if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600))
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      if (lstatSync(path + suffix, { throwIfNoEntry: false }))
        privateEntry(path + suffix, false)
    this.database = new DatabaseSync(path, {
      timeout: 1000,
      allowExtension: false,
    })
    try {
      this.database.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA trusted_schema=OFF;
        CREATE TABLE IF NOT EXISTS replay_meta (id INTEGER PRIMARY KEY CHECK(id=1), high_water INTEGER NOT NULL) STRICT;
        INSERT OR IGNORE INTO replay_meta VALUES (1,0);
        CREATE TABLE IF NOT EXISTS seen_commands (
          cmd_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, nonce TEXT NOT NULL,
          printer_id TEXT NOT NULL, accepted_at INTEGER NOT NULL, retain_until INTEGER NOT NULL,
          UNIQUE(key_id,nonce)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS recent_printer_commands ON seen_commands(printer_id,accepted_at);
        CREATE INDEX IF NOT EXISTS expiring_commands ON seen_commands(retain_until);
      `)
    } catch (error) {
      this.database.close()
      throw error
    }
  }
  claim(input: SignedCommand, now: number): ClaimResult {
    const command = SignedCommand.parse(input)
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - 600_000 ||
      command.expires_at <= now
    )
      throw new Error('Invalid claim time')
    this.database.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      const meta = this.database
        .prepare('SELECT high_water FROM replay_meta WHERE id=1')
        .get()
      if (!meta || typeof meta.high_water !== 'number')
        throw new Error('Invalid replay metadata')
      if (now < meta.high_water) return 'clock-regressed'
      this.database
        .prepare('DELETE FROM seen_commands WHERE retain_until <= ?')
        .run(now)
      const seen = this.database
        .prepare(
          'SELECT 1 FROM seen_commands WHERE cmd_id=? OR (key_id=? AND nonce=?) LIMIT 1',
        )
        .get(command.cmd_id, command.key_id, command.nonce)
      if (seen) return 'replay'
      const count = this.database
        .prepare('SELECT COUNT(*) AS count FROM seen_commands')
        .get()
      if (!count || typeof count.count !== 'number')
        throw new Error('Invalid replay count')
      if (count.count >= this.capacity) return 'capacity'
      const recent = this.database
        .prepare(
          'SELECT COUNT(*) AS count FROM seen_commands WHERE printer_id=? AND accepted_at>?',
        )
        .get(command.printer_id, now - 60_000)
      if (!recent || typeof recent.count !== 'number')
        throw new Error('Invalid rate count')
      if (recent.count >= 10 && command.action !== 'emergency_stop')
        return 'rate-limited'
      this.database
        .prepare('INSERT INTO seen_commands VALUES (?,?,?,?,?,?)')
        .run(
          command.cmd_id,
          command.key_id,
          command.nonce,
          command.printer_id,
          now,
          now + 600_000,
        )
      this.database
        .prepare('UPDATE replay_meta SET high_water=? WHERE id=1')
        .run(now)
      this.database.exec('COMMIT')
      committed = true
      return 'accepted'
    } finally {
      if (!committed) this.database.exec('ROLLBACK')
    }
  }
  close() {
    this.database.close()
  }
}
