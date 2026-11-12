import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  acquireQueueLock,
  type LockProbe,
} from '../../packages/connector/src/cloud/queue-lock.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'

const queueModule = new URL(
  '../../packages/connector/src/cloud/queue.ts',
  import.meta.url,
).href
function scratch() {
  return mkdtempSync(join(tmpdir(), 'open3d-queue-lock-'))
}
const probe = (over: Partial<LockProbe> = {}): LockProbe => ({
  hostname: () => 'host-a',
  boot: () => 'boot-1',
  pidNamespace: () => 'pid:[1]',
  startTime: () => 'start-1',
  alive: () => true,
  ...over,
})
const owner = {
  version: 2,
  pid: 4242,
  host: 'host-a',
  boot: 'boot-1',
  ns: 'pid:[1]',
  start: 'start-1',
  instance: '00000000-0000-4000-8000-000000000001',
}
function withLock(content: unknown, run: (path: string) => void) {
  const dir = scratch()
  try {
    const path = join(dir, 'telemetry.lock')
    writeFileSync(path, JSON.stringify(content), { mode: 0o600 })
    run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const lockOwner = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as typeof owner

/** Opens a queue in a child process and keeps it alive until killed. */
async function holdInChild(directory: string) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { TelemetryQueue } from ${JSON.stringify(queueModule)}
       new TelemetryQueue(process.argv[1], 1000)
       process.stdout.write('ready\\n')
       setInterval(() => {}, 1000)`,
      directory,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const lines = createInterface({ input: child.stdout })
  await once(lines, 'line', { signal: AbortSignal.timeout(5000) })
  lines.close()
  return child
}

test('a SIGKILLed owner is recovered automatically on restart', async () => {
  const dir = scratch()
  const child = await holdInChild(dir)
  try {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    const queue = new TelemetryQueue(dir, 1001)
    assert.equal(queue.recoveredStaleLock, true)
    assert.equal(lockOwner(join(dir, 'telemetry.lock')).pid, process.pid)
    queue.close()
    const clean = new TelemetryQueue(dir, 1002)
    assert.equal(clean.recoveredStaleLock, false)
    clean.close()
  } finally {
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live owner in another process is never displaced', async () => {
  const dir = scratch()
  const child = await holdInChild(dir)
  try {
    const before = readFileSync(join(dir, 'telemetry.lock'), 'utf8')
    assert.throws(() => new TelemetryQueue(dir, 1000), /EEXIST/)
    assert.equal(readFileSync(join(dir, 'telemetry.lock'), 'utf8'), before)
  } finally {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live owner in the same process is never displaced', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000)
    assert.throws(() => new TelemetryQueue(dir, 1000), /EEXIST/)
    queue.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reused PID with a different start time is stale', () => {
  withLock(owner, (path) => {
    const result = acquireQueueLock(
      path,
      probe({ startTime: (pid) => (pid === 4242 ? 'start-2' : 'start-1') }),
    )
    assert.deepEqual(result, { recovered: true })
    assert.notEqual(lockOwner(path).instance, owner.instance)
  })
})

test('a dead PID is stale and a reboot makes any PID stale', () => {
  withLock(owner, (path) => {
    assert.deepEqual(acquireQueueLock(path, probe({ alive: () => false })), {
      recovered: true,
    })
  })
  withLock(owner, (path) => {
    assert.deepEqual(acquireQueueLock(path, probe({ boot: () => 'boot-2' })), {
      recovered: true,
    })
  })
})

test('ambiguous owners fail closed and leave the lock untouched', () => {
  const cases: Array<[string, unknown, Partial<LockProbe>]> = [
    ['live with matching start', owner, {}],
    ['live with unknown start', { ...owner, start: null }, {}],
    ['live, start unreadable', owner, { startTime: () => undefined }],
    ['other host', owner, { hostname: () => 'host-b', alive: () => false }],
    [
      'other PID namespace',
      owner,
      { pidNamespace: () => 'pid:[2]', alive: () => false },
    ],
    ['boot identity unknown', owner, { boot: () => undefined }],
    ['legacy PID-only lock', { pid: 4242 }, { alive: () => false }],
    ['unparseable lock', 'not json', { alive: () => false }],
  ]
  for (const [label, content, override] of cases)
    withLock(content, (path) => {
      const before = readFileSync(path, 'utf8')
      assert.throws(
        () => acquireQueueLock(path, probe(override)),
        /EEXIST/,
        label,
      )
      assert.equal(readFileSync(path, 'utf8'), before, label)
    })
})

test('a concurrent recovery in progress fails closed', () => {
  withLock(owner, (path) => {
    writeFileSync(path + '.recover', '', { mode: 0o600 })
    assert.throws(
      () => acquireQueueLock(path, probe({ alive: () => false })),
      /EEXIST/,
    )
    assert.equal(lockOwner(path).instance, owner.instance)
    assert.equal(existsSync(path + '.recover'), true)
  })
})

test('collection reports a recovered lock as a diagnostic', async () => {
  const dir = scratch()
  const child = await holdInChild(dir)
  let queue: TelemetryQueue | undefined
  try {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    queue = new TelemetryQueue(dir, 1001)
    const diagnostics: { kind: string }[] = []
    const { collectIntoQueue } =
      await import('../../packages/connector/src/runtime/collect.ts')
    await collectIntoQueue({
      config: { version: 1, allowedOrigins: [], printers: [] } as never,
      queue,
      signal: AbortSignal.abort(),
      onDiagnostic: (value) => diagnostics.push(value),
    })
    assert.equal(diagnostics[0]?.kind, 'queue-lock-recovered')
  } finally {
    queue?.close()
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
