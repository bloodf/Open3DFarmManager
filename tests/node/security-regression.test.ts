import {
  createBrowserKey,
  signCommand,
  encodeCommand,
  canonicalize,
  base64url,
} from '@open3dfarmmanager/farm-protocol'
import { authorizeCommand } from '../../packages/connector/src/auth/verify.ts'
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
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  let replay: PersistentReplayStore | undefined
  try {
    const pair = await createBrowserKey()
    const id = '00000000-0000-4000-8000-000000000001'
    const command = await signCommand(
      {
        farm_id: id,
        agent_id: id,
        printer_id: id,
        user_id: id,
        key_id: id,
        session_id: id,
        action: 'pause',
      },
      pair.privateKey,
      1000,
    )
    const context = {
      farmId: id,
      agentId: id,
      userId: id,
      keyId: id,
      sessionId: id,
      printerIds: new Set([id]),
      now: 1000,
      authorization: { issuedAt: 1000, expiresAt: 61000 },
      key: {
        id,
        farmId: id,
        userId: id,
        role: 'operator' as const,
        revokedAt: null,
        publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
      },
    }
    const wire = encodeCommand(command)
    let claims = 0
    assert.deepEqual(
      authorizeCommand(wire.replace('"v":1', '"v":1,"\\u0076":1'), context, {
        claim() {
          claims++
          return 'accepted'
        },
      }),
      { ok: false, reason: 'invalid-command' },
    )
    assert.equal(claims, 0)
    replay = new PersistentReplayStore(dir)
    assert.equal(authorizeCommand(wire, context, replay).ok, true)
    replay.close()
    replay = undefined
    const { sig: originalSignature, ...payload } = command
    const signedAgain = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new TextEncoder().encode(canonicalize(payload)),
        ),
      ),
    )
    assert.equal(typeof originalSignature, 'string')
    replay = new PersistentReplayStore(dir)
    assert.deepEqual(
      authorizeCommand(
        encodeCommand({ ...payload, sig: signedAgain }),
        context,
        replay,
      ),
      { ok: false, reason: 'replay' },
    )
  } finally {
    replay?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('SQLite claims serialize across separate OS processes', async () => {
  const dir = scratch()
  try {
    const initialized = new PersistentReplayStore(dir)
    initialized.close()
    const pair = await createBrowserKey()
    const id = '00000000-0000-4000-8000-000000000001'
    const command = await signCommand(
      {
        farm_id: id,
        agent_id: id,
        printer_id: id,
        user_id: id,
        key_id: id,
        session_id: id,
        action: 'pause',
      },
      pair.privateKey,
      1000,
    )
    const module = new URL(
      '../../packages/connector/src/auth/replay.ts',
      import.meta.url,
    ).href
    const source = `import { PersistentReplayStore } from ${JSON.stringify(module)}; const store = new PersistentReplayStore(process.argv[1]); try { process.stdout.write(store.claim(JSON.parse(process.argv[2]), 1000)) } finally { store.close() }`
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
              { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
            )
            let output = ''
            let stderr = Buffer.alloc(0)
            child.stderr.on('data', (chunk: Buffer) => {
              stderr = Buffer.concat([
                stderr,
                chunk.subarray(0, 4096 - stderr.length),
              ])
            })
            child.stdout.on('data', (chunk) => {
              output += chunk
            })
            child.on('error', reject)
            child.on('close', (status, signal) =>
              status === 0
                ? resolve(output)
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
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity and queue readers reject FIFOs without blocking', async () => {
  for (const kind of ['identity', 'queue']) {
    const dir = scratch()
    try {
      execFileSync('mkfifo', [
        '-m',
        '600',
        join(dir, kind === 'identity' ? 'identity.json' : 'telemetry.jsonl'),
      ])
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
      const source = `import * as mod from ${JSON.stringify(module)}; setTimeout(() => { process.stdout.write('ready\\n'); process.stdin.once('data', () => { try { ${invoke}; process.exitCode = 2 } catch (error) { if (!error.message.includes('private files')) process.exitCode = 3 } process.stdin.destroy() }) }, 250)`
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', source, dir],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      let spawnError: Error | undefined
      child.on('error', (error) => {
        spawnError = error
      })
      child.stdin.on('error', (error) => {
        spawnError = error
      })
      const exited = new Promise<number | null>((resolve) =>
        child.once('close', resolve),
      )
      const ready = new Promise<void>((resolve) => {
        let output = ''
        child.stdout.on('data', (chunk) => {
          output += chunk.toString()
          if (output.includes('ready\n')) resolve()
        })
      })
      async function bounded<T>(
        promise: Promise<T>,
        milliseconds: number,
        label: string,
      ): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(label)), milliseconds)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      try {
        await bounded(
          Promise.race([
            ready,
            exited.then(() => {
              throw (
                spawnError ?? new Error('FIFO worker exited before readiness')
              )
            }),
          ]),
          5000,
          'FIFO worker startup timed out',
        )
        child.stdin.end('run\n')
        assert.equal(await bounded(exited, 2000, 'FIFO reader blocked'), 0)
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
        await exited
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

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
