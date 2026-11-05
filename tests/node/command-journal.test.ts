import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  openCommandJournal,
  claimCommand,
  markWriteStarted,
  finishCommand,
  readCommandOutcome,
  closeCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'

const base = '/tmp/open3dfarm-pause-dispatch'
function fixture() {
  const directory = mkdtempSync(join(base, 'journal-'))
  let now = 1000
  const journal = openCommandJournal({ directory, clock: () => now })
  const scope = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'text_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  function command(patch: Record<string, unknown> = {}) {
    return {
      v: 2 as const,
      purpose: 'printer-pause' as const,
      cmd_id: randomUUID(),
      ...scope,
      action: 'pause' as const,
      args: {},
      issued_at: 1000,
      expires_at: 6000,
      nonce: randomBytes(16).toString('base64url'),
      sig: 'A'.repeat(86),
      ...patch,
    }
  }
  function claim(value = command(), printerKey = 'printer-1') {
    return claimCommand(journal, {
      command: value,
      printerKey,
      wireSha256: randomBytes(32).toString('hex'),
    })
  }
  function cleanup() {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
  return {
    directory,
    journal,
    scope,
    command,
    claim,
    cleanup,
    setNow: (n: number) => {
      now = n
    },
  }
}

test('durable claim excludes replay and printer replacement; unresolved survives reopen', () => {
  const f = fixture()
  try {
    const command = f.command(),
      first = f.claim(command)
    assert.ok(first.ok)
    assert.deepEqual(f.claim(command), { ok: false, reason: 'replay' })
    assert.deepEqual(f.claim(f.command()), {
      ok: false,
      reason: 'assignment-busy',
    })
    assert.deepEqual(f.claim(f.command({ assignment_id: randomUUID() })), {
      ok: false,
      reason: 'assignment-busy',
    })
    assert.equal(markWriteStarted(f.journal, first.receipt), true)
    closeCommandJournal(f.journal)
    const reopened = openCommandJournal({
      directory: f.directory,
      clock: () => 1000,
    })
    try {
      assert.equal(
        readCommandOutcome(reopened, command.cmd_id)?.status,
        'outcome-unknown',
      )
      assert.deepEqual(
        claimCommand(reopened, {
          command: f.command({ assignment_id: randomUUID() }),
          printerKey: 'printer-1',
          wireSha256: randomBytes(32).toString('hex'),
        }),
        { ok: false, reason: 'assignment-busy' },
      )
    } finally {
      closeCommandJournal(reopened)
    }
  } finally {
    f.cleanup()
  }
})

test('final outcomes consume receipts, preserve replay, and retention permits later fresh claim', () => {
  const f = fixture()
  try {
    const first = f.command(),
      claim = f.claim(first)
    assert.ok(claim.ok)
    assert.equal(
      finishCommand(f.journal, claim.receipt, 'not-sent', 'guard-denied'),
      true,
    )
    assert.equal(
      finishCommand(f.journal, claim.receipt, 'not-sent', 'guard-denied'),
      false,
    )
    assert.deepEqual(f.claim(first), { ok: false, reason: 'replay' })
    f.setNow(601001)
    const later = f.claim(f.command({ issued_at: 601001, expires_at: 606001 }))
    assert.ok(later.ok)
  } finally {
    f.cleanup()
  }
})

test('child process crash before or after write-start leaves durable unknown', () => {
  for (const phase of ['claimed', 'started']) {
    const f = fixture()
    try {
      const childCommand = f.command()
      const script = `import {openCommandJournal,claimCommand,markWriteStarted} from './packages/connector/src/control/command-journal.ts'; const [directory,input,phase]=process.argv.slice(1);const j=openCommandJournal({directory,clock:()=>1000});const result=claimCommand(j,JSON.parse(input));if(!result.ok)process.exit(3);if(phase==='started'&&!markWriteStarted(j,result.receipt))process.exit(4);process.kill(process.pid,'SIGKILL')`
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          script,
          f.directory,
          JSON.stringify({
            command: childCommand,
            printerKey: 'printer-1',
            wireSha256: randomBytes(32).toString('hex'),
          }),
          phase,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 },
      )
      assert.equal(child.signal, 'SIGKILL', child.stderr)
      assert.equal(
        readCommandOutcome(f.journal, childCommand.cmd_id)?.status,
        'outcome-unknown',
      )
      assert.deepEqual(f.claim(f.command({ assignment_id: randomUUID() })), {
        ok: false,
        reason: 'assignment-busy',
      })
    } finally {
      f.cleanup()
    }
  }
})

test('capacity, rate and backwards clock fail closed without evicting active rows', () => {
  const f = fixture()
  try {
    for (let i = 0; i < 10; i++) {
      const claimed = f.claim(f.command({ assignment_id: randomUUID() }))
      assert.ok(claimed.ok)
      assert.equal(
        finishCommand(f.journal, claimed.receipt, 'not-sent', 'not-sent'),
        true,
      )
    }
    assert.deepEqual(f.claim(f.command({ assignment_id: randomUUID() })), {
      ok: false,
      reason: 'rate-limited',
    })
    f.setNow(999)
    assert.deepEqual(f.claim(), { ok: false, reason: 'clock-regressed' })
  } finally {
    f.cleanup()
  }
  const directory = mkdtempSync(join(base, 'capacity-'))
  const j = openCommandJournal({ directory, clock: () => 1000, capacity: 1 })
  const other = fixture()
  try {
    const a = claimCommand(j, {
      command: other.command(),
      printerKey: 'a',
      wireSha256: 'a'.repeat(64),
    })
    assert.ok(a.ok)
    assert.deepEqual(
      claimCommand(j, {
        command: other.command({ assignment_id: randomUUID() }),
        printerKey: 'b',
        wireSha256: 'b'.repeat(64),
      }),
      { ok: false, reason: 'capacity' },
    )
  } finally {
    closeCommandJournal(j)
    other.cleanup()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('SQLite failures fail closed and do not release unresolved attempt', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const f = fixture(),
    db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER test_fail_insert BEFORE INSERT ON pause_commands BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    )
    assert.deepEqual(f.claim(), { ok: false, reason: 'storage-unavailable' })
    db.exec('DROP TRIGGER test_fail_insert')
    const first = f.command(),
      claim = f.claim(first)
    assert.ok(claim.ok)
    db.exec(
      "CREATE TRIGGER test_fail_update BEFORE UPDATE ON pause_commands BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    )
    assert.equal(markWriteStarted(f.journal, claim.receipt), false)
    assert.equal(
      finishCommand(f.journal, claim.receipt, 'not-sent', 'storage'),
      false,
    )
    db.exec('DROP TRIGGER test_fail_update')
    assert.equal(
      readCommandOutcome(f.journal, first.cmd_id)?.status,
      'outcome-unknown',
    )
    assert.deepEqual(f.claim(f.command({ assignment_id: randomUUID() })), {
      ok: false,
      reason: 'assignment-busy',
    })
  } finally {
    db.close()
    f.cleanup()
  }
})

test('independent processes race the same assignment without a queue', async () => {
  const f = fixture()
  const script = `import {openCommandJournal,claimCommand} from './packages/connector/src/control/command-journal.ts'; const [directory,input]=process.argv.slice(1); const j=openCommandJournal({directory,clock:()=>1000}); console.log('ready'); process.stdin.once('data',()=>{const result=claimCommand(j,JSON.parse(input)); console.log(JSON.stringify(result.ok ? {ok:true}:result));process.exit(0)})`
  const ready: Array<() => void> = []
  const children = [0, 1].map(() =>
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        script,
        f.directory,
        JSON.stringify({
          command: f.command(),
          printerKey: 'printer-1',
          wireSha256: randomBytes(32).toString('hex'),
        }),
      ],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
    ),
  )
  try {
    const results = children.map(
      (child) =>
        new Promise<{ ok: boolean; reason?: string }>((resolve, reject) => {
          let output = '',
            stderr = ''
          const timer = setTimeout(() => {
            child.kill()
            reject(new Error('child race timed out'))
          }, 5000)
          child.stdout.on('data', (chunk) => {
            output += chunk
            if (output.includes('ready\n')) {
              child.stdout.removeAllListeners('data')
              resolveReady()
            }
          })
          function resolveReady() {
            ready.push(() => child.stdin.write('go\n'))
            child.stdout.on('data', (chunk) => {
              output += chunk
            })
          }
          child.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          child.on('error', reject)
          child.on('close', (code) => {
            clearTimeout(timer)
            if (code !== 0) return reject(new Error('child failed ' + stderr))
            const line = output.trim().split('\n').at(-1)
            try {
              resolve(JSON.parse(line ?? ''))
            } catch (e) {
              reject(e)
            }
          })
        }),
    )
    const deadline = Date.now() + 5000
    while (ready.length < 2) {
      assert.ok(Date.now() < deadline, 'children failed to reach barrier')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    for (const release of ready) release()
    const outcomes = await Promise.all(results)
    assert.equal(outcomes.filter((x) => x.ok).length, 1)
    assert.equal(
      outcomes.filter(
        (x) =>
          !x.ok &&
          ['assignment-busy', 'storage-unavailable'].includes(x.reason ?? ''),
      ).length,
      1,
    )
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    f.cleanup()
  }
})

test('unknown database application ID is rejected before journal mode changes', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { chmodSync } = await import('node:fs')
  const directory = mkdtempSync(join(base, 'foreign-')),
    path = join(directory, 'pause-commands.sqlite')
  const db = new DatabaseSync(path)
  try {
    chmodSync(path, 0o600)
    db.exec(
      'PRAGMA journal_mode=DELETE; PRAGMA application_id=12345; PRAGMA user_version=1',
    )
    assert.throws(() => openCommandJournal({ directory, clock: () => 1000 }))
    assert.equal(
      db.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'delete',
    )
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
