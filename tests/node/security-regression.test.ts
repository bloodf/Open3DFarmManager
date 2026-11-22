import {
  decodeCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
  rejected,
  type V2Dispatch,
} from '../helpers/command-v2-dispatch.ts'
import { spawn, execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  linkSync,
  symlinkSync,
  lstatSync,
} from 'node:fs'
import { join } from 'node:path'
import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { loadExistingIdentity } from '../../packages/connector/src/identity/store.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { PersistentReplayStore } from '../../packages/connector/src/auth/replay.ts'
const scratch = () => mkdtempSync(join(tmpdir(), 'open3d-security-regression-'))
const state = {
  printerKey: 'synthetic',
  state: 'idle' as const,
  progress: 0,
  observedAt: 1000,
}

test('identity decoding errors never echo malformed key-file contents', () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, 'identity.json'), 'TEST_PRIVATE_MARKER', {
      mode: 0o600,
    })
    let message = ''
    try {
      loadExistingIdentity(dir)
      assert.fail('expected rejection')
    } catch (error) {
      message = String(error)
    }
    assert.ok(!message.includes('TEST_'))
    assert.match(message, /Invalid identity/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('missing queue log cannot silently discard an orphan compaction candidate', () => {
  const dir = scratch()
  try {
    const temporary = join(dir, 'telemetry.compact')
    writeFileSync(temporary, 'PRESERVE_RECOVERY_CANDIDATE', { mode: 0o600 })
    assert.throws(() => new TelemetryQueue(dir, 1000), /recovery/)
    assert.equal(readFileSync(temporary, 'utf8'), 'PRESERVE_RECOVERY_CANDIDATE')
    assert.equal(existsSync(join(dir, 'telemetry.jsonl')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('queue append rejects a substituted hard link without modifying the target', () => {
  const dir = scratch()
  let queue: TelemetryQueue | undefined
  try {
    queue = new TelemetryQueue(dir, 1000)
    const target = join(dir, 'untouched')
    writeFileSync(target, 'UNCHANGED', { mode: 0o600 })
    rmSync(join(dir, 'telemetry.jsonl'))
    linkSync(target, join(dir, 'telemetry.jsonl'))
    assert.throws(() => queue!.enqueue(state, 1000), /private files/)
    assert.equal(readFileSync(target, 'utf8'), 'UNCHANGED')
  } finally {
    queue?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('dangling SQLite sidecar symlinks are rejected before SQLite opens them', () => {
  const dir = scratch()
  let store: PersistentReplayStore | undefined
  try {
    const target = join(dir, 'outside-wal')
    symlinkSync(target, join(dir, 'replay.sqlite-wal'))
    assert.throws(() => {
      store = new PersistentReplayStore(dir)
    }, /private files/)
    assert.equal(existsSync(target), false)
  } finally {
    store?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resigning a claimed payload cannot bypass replay after restart; duplicate fields never reach storage', async () => {
  const dir = scratch()
  let harness: V2Dispatch | undefined
  try {
    const signer = await nodeSigner()
    const authority = await createV2Authority(signer)
    harness = await openV2Dispatch(authority, { directory: dir })
    // Issued after both capabilities, so only replay protection can refuse it.
    const unsigned = authority.command({}, 1050)
    harness.advance(60)
    const wire = encodeCommandV2(await signer.signCommand(unsigned))
    assert.deepEqual(
      await harness.dispatch(wire.replace('"v":2', '"v":2,"\\u0076":2')),
      rejected('invalid-command'),
    )
    assert.equal(harness.claims(), 0)
    assert.equal((await harness.dispatch(wire)).kind, 'applied')
    harness.close()
    harness = undefined
    // ECDSA signatures are randomized: the same payload signed again has a
    // different signature but the same command ID and nonce.
    const signedAgain = encodeCommandV2(await signer.signCommand(unsigned))
    assert.notEqual(signedAgain, wire)
    harness = await openV2Dispatch(authority, { directory: dir, now: 1050 })
    harness.advance(100)
    assert.deepEqual(await harness.dispatch(signedAgain), rejected('replay'))
    assert.equal(harness.claims(), 1)
    assert.equal(harness.writes(), 0)
  } finally {
    harness?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
// Children report through exit; the test timeout is the single hang bound.
test(
  'command journal claims serialize across separate OS processes',
  {
    timeout: 30000,
  },
  async (t) => {
    const dir = scratch()
    const spawned: ReturnType<typeof spawn>[] = []
    // Also runs when the test times out, unlike the finally below.
    t.after(() => {
      for (const child of spawned) if (child.exitCode === null) child.kill()
    })
    try {
      closeCommandJournal(
        openCommandJournal({ directory: dir, clock: () => 1000 }),
      )
      const authority = await createV2Authority(await nodeSigner())
      const command = decodeCommandV2(await authority.sign())
      const module = new URL(
        '../../packages/connector/src/control/command-journal.ts',
        import.meta.url,
      ).href
      // Each worker opens its store (a write of its own), announces 'ready' and
      // claims only after all four are released together, so the race covers
      // the claims rather than four concurrent store initialisations.
      const source = `import { openCommandJournal, claimCommand, closeCommandJournal } from ${JSON.stringify(module)}; const journal = openCommandJournal({ directory: process.argv[1], clock: () => 1000 }); process.stdout.write('ready\\n'); process.stdin.once('data', () => { try { const result = claimCommand(journal, { command: JSON.parse(process.argv[2]), printerKey: 'printer-1', wireSha256: 'a'.repeat(64) }); process.stdout.write(result.ok ? 'accepted' : result.reason) } finally { closeCommandJournal(journal); process.stdin.destroy() } })`
      let ready = 0
      const results = await Promise.all(
        Array.from(
          { length: 4 },
          (_, worker) =>
            new Promise<string>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                [
                  '--input-type=module',
                  '-e',
                  source,
                  dir,
                  JSON.stringify(command),
                ],
                { stdio: ['pipe', 'pipe', 'pipe'] },
              )
              spawned.push(child)
              let output = ''
              let stderr = Buffer.alloc(0)
              child.stderr.on('data', (chunk: Buffer) => {
                stderr = Buffer.concat([
                  stderr,
                  chunk.subarray(0, 4096 - stderr.length),
                ])
              })
              child.stdout.on('data', (chunk) => {
                const before = output
                output += chunk
                if (!before.includes('ready\n') && output.includes('ready\n'))
                  if (++ready === 4)
                    for (const each of spawned) each.stdin!.write('go\n')
              })
              child.on('error', reject)
              child.on('close', (status, signal) =>
                status === 0
                  ? resolve(output.replace('ready\n', ''))
                  : reject(
                      new Error(
                        `Replay worker failed: worker=${worker}, code=${status}, signal=${signal}, stderr=${JSON.stringify(stderr.toString('utf8'))}`,
                      ),
                    ),
              )
            }),
        ),
      )
      assert.equal(results.filter((result) => result === 'accepted').length, 1)
      assert.equal(results.filter((result) => result === 'replay').length, 3)
    } finally {
      for (const child of spawned) if (child.exitCode === null) child.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// Startup covers process boot, TypeScript stripping and the connector import
// graph, which slows sharply under CPU contention (about 100 ms idle, about 1 s
// at 4x oversubscription, and past 5 s on a loaded Linux host). It is bounded
// separately and generously so a slow boot is reported as such. The FIFO
// operation deadline starts only after readiness and stays strict: a reader that
// opens the FIFO blocks until the deadline and fails as 'FIFO reader blocked'.
const FIFO_WORKER_STARTUP_MS = 30_000
const FIFO_OPERATION_MS = 2_000
const FIFO_STDERR_LIMIT = 4096

async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  describe: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(describe())), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test(
  'identity and queue readers reject FIFOs without blocking',
  { timeout: 2 * (FIFO_WORKER_STARTUP_MS + FIFO_OPERATION_MS) + 10_000 },
  async (t) => {
    const spawned: ReturnType<typeof spawn>[] = []
    // Also runs when the test times out, unlike the finally below.
    t.after(() => {
      for (const child of spawned)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
    })
    for (const kind of ['identity', 'queue']) {
      const dir = scratch()
      try {
        const fifo = join(
          dir,
          kind === 'identity' ? 'identity.json' : 'telemetry.jsonl',
        )
        execFileSync('mkfifo', ['-m', '600', fifo])
        assert.ok(lstatSync(fifo).isFIFO(), `${kind} fixture is not a FIFO`)
        const module = new URL(
          kind === 'identity'
            ? '../../packages/connector/src/identity/store.ts'
            : '../../packages/connector/src/cloud/queue.ts',
          import.meta.url,
        ).href
        const invoke =
          kind === 'identity'
            ? 'mod.loadExistingIdentity(process.argv[1])'
            : 'new mod.TelemetryQueue(process.argv[1], 1000)'
        // The startup delay verifies the FIFO deadline begins only after imports and readiness.
        const source = `import * as mod from ${JSON.stringify(module)}; setTimeout(() => { process.stdout.write('ready ' + Math.round(process.uptime() * 1000) + '\\n'); process.stdin.once('data', () => { try { ${invoke}; process.exitCode = 2 } catch (error) { if (!error.message.includes('private files')) process.exitCode = 3 } process.stdin.destroy() }) }, 250)`
        const started = performance.now()
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', source, dir],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        )
        spawned.push(child)
        let spawnError: Error | undefined
        child.on('error', (error) => {
          spawnError = error
        })
        child.stdin.on('error', (error) => {
          spawnError = error
        })
        let stdout = ''
        let stderr = Buffer.alloc(0)
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = Buffer.concat([
            stderr,
            chunk.subarray(0, FIFO_STDERR_LIMIT - stderr.length),
          ])
        })
        const exited = new Promise<number | null>((resolve) =>
          child.once('close', resolve),
        )
        const ready = new Promise<void>((resolve) => {
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString()
            if (/^ready \d+\n/.test(stdout)) resolve()
          })
        })
        const diagnose = (label: string) => () =>
          `${label}: kind=${kind}, pid=${child.pid}, elapsedMs=${Math.round(performance.now() - started)}, exitCode=${child.exitCode}, signal=${child.signalCode}, loadavg=${loadavg()
            .map((value) => value.toFixed(2))
            .join(
              '/',
            )}, cpus=${availableParallelism()}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr.toString('utf8'))}`
        try {
          await bounded(
            Promise.race([
              ready,
              exited.then(() => {
                throw (
                  spawnError ??
                  new Error(diagnose('FIFO worker exited before readiness')())
                )
              }),
            ]),
            FIFO_WORKER_STARTUP_MS,
            diagnose('FIFO worker startup timed out'),
          )
          child.stdin.end('run\n')
          assert.equal(
            await bounded(
              exited,
              FIFO_OPERATION_MS,
              diagnose('FIFO reader blocked'),
            ),
            0,
            diagnose('FIFO reader did not reject with a private-files error')(),
          )
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
          await exited
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  },
)

test('queue decoding errors never echo malformed telemetry contents', () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, 'telemetry.jsonl'), 'TEST_TELEMETRY_MARKER\n', {
      mode: 0o600,
    })
    let message = ''
    try {
      new TelemetryQueue(dir, 1000)
      assert.fail('expected rejection')
    } catch (error) {
      message = String(error)
    }
    assert.ok(!message.includes('TEST_'))
    assert.match(message, /Invalid queue/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
