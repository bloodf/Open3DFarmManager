import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(
  new URL('../../scripts/klipper-diagnostics.mjs', import.meta.url),
)

test('collects bounded simulator diagnostics and never emits raw configuration or secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-diag-test-'))
  try {
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh
case "$*" in
  *"ps -aq sv06"*) echo aaaaaaaaaaaa ;;
  *"ps -aq u1"*) echo bbbbbbbbbbbb ;;
  "inspect --format"*) echo 'running 0 false' ;;
  *"supervisorctl status"*) printf 'klipper FATAL test-secret\\nmoonraker RUNNING pid 3\\n'; exit 3 ;;
  *"cpu.max"*) printf '200000 100000\\n' ;;
  *"cpu.pressure"*) printf 'some avg10=12.50 avg60=3.00 avg300=1.00 total=12345\\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\\n' ;;
  *"cpu.stat"*) printf 'usage_usec 12\\nnr_periods 4\\nnr_throttled 2\\nthrottled_usec 6\\n' ;;
  *"tail -c"*) printf '[config] SECRET_MARKER\\nMCU shutdown: Timer too close SECRET_MARKER\\nStats 99.0: bytes_read=42 bytes_invalid=3 freq=1000 secret=987\\n' ;;
  "logs"*) printf 'Timeout on connect SECRET_MARKER\\n' >&2 ;;
esac
`,
      { mode: 0o700 },
    )
    const run = spawnSync(process.execPath, [script, 'synthetic-project'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(run.status, 0)
    assert.doesNotMatch(
      run.stdout + run.stderr,
      /SECRET_MARKER|test-secret|secret=987/,
    )
    const rows = run.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].service, 'sv06')
    assert.equal(rows[0].container, 'running 0 false')
    assert.equal(rows[0].processes.klipper, 'FATAL')
    assert.equal(rows[0].logs.klippy.counts['timer-too-close'], 1)
    assert.equal(rows[0].logs.klippy.stats[0].bytes_invalid, 3)
    assert.equal(rows[0].stdout.counts['identify-timeout'], 1)
    assert.equal(rows[0].cpu.nr_throttled, 2)
    assert.equal(rows[1].service, 'u1')
    assert.deepEqual(rows[0].cpuQuota, {
      quotaUsec: 200000,
      periodUsec: 100000,
    })
    assert.deepEqual(rows[0].cpuPressure.some, {
      avg10: 12.5,
      avg60: 3,
      avg300: 1,
      totalUsec: 12345,
    })
    assert.equal(rows[0].cpuPressure.full.totalUsec, 0)
    assert.ok(Number.isSafeInteger(rows[0].host.availableParallelism))
    assert.ok(rows[0].host.availableParallelism > 0)
    assert.equal(rows[0].host.loadavg.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const vocabulary = [
  'communication-error',
  'identify-response-error',
  'identify-timeout',
  'mcu-connect',
  'mcu-identify',
  'mcu-no-communication',
  'serial-port-error',
  'shutdown',
  'supervisor-process-exited',
  'supervisor-process-running',
  'timer-too-close',
  'traceback',
]

function collectWithLogs(logs: {
  klippy?: string
  moonraker?: string
  supervisord?: string
  stdout?: string
}) {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-diag-test-'))
  try {
    for (const name of [
      'klippy',
      'moonraker',
      'supervisord',
      'stdout',
    ] as const)
      writeFileSync(join(dir, `${name}.log`), logs[name] ?? '')
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh
case "$*" in
  *"ps -aq sv06"*) echo aaaaaaaaaaaa ;;
  *"ps -aq u1"*) echo bbbbbbbbbbbb ;;
  "inspect --format"*) echo 'running 0 false' ;;
  *"supervisorctl status"*) printf 'klipper RUNNING\\nmoonraker RUNNING\\nsimulavr RUNNING\\nwebcamd RUNNING\\n' ;;
  *klippy.log*) cat '${dir}/klippy.log' ;;
  *moonraker.log*) cat '${dir}/moonraker.log' ;;
  *supervisord.log*) cat '${dir}/supervisord.log' ;;
  "logs"*) cat '${dir}/stdout.log' >&2 ;;
esac
`,
      { mode: 0o700 },
    )
    const run = spawnSync(process.execPath, [script, 'synthetic-project'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(run.status, 0)
    const rows = run.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    return { output: run.stdout + run.stderr, rows }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('classifies runtime exceptions and allowlisted Supervisor lifecycle events', () => {
  const { output, rows } = collectWithLogs({
    klippy: [
      "mcu 'mcu': No communication with MCU",
      "error: mcu 'mcu': Unable to obtain 'identify_response' response",
      "mcu 'mcu': Unable to open serial port: [Errno 2] No such file or directory: '/dev/ttyACM0'",
    ].join('\n'),
    supervisord: [
      '2026-11-05 10:00:00,000 INFO success: klipper entered RUNNING state, process has stayed up for > than 5 seconds (startsecs)',
      '2026-11-05 10:00:01,000 INFO exited: simulavr (exit status 1; not expected)',
    ].join('\n'),
    stdout: "error: Unable to obtain 'identify_response' response\n",
  })
  assert.equal(rows.length, 2)
  const row = rows[0]
  assert.equal(row.logs.klippy.counts['mcu-no-communication'], 1)
  assert.equal(row.logs.klippy.counts['identify-response-error'], 1)
  assert.equal(row.logs.klippy.counts['serial-port-error'], 1)
  assert.equal(row.logs.klippy.counts['traceback'], 0)
  assert.equal(row.logs.klippy.counts['communication-error'], 0)
  assert.equal(row.logs.supervisord.counts['supervisor-process-running'], 1)
  assert.equal(row.logs.supervisord.counts['supervisor-process-exited'], 1)
  assert.equal(row.logs.supervisord.counts['mcu-no-communication'], 0)
  assert.equal(row.logs.moonraker.counts['identify-response-error'], 0)
  assert.equal(row.stdout.counts['identify-response-error'], 1)
  assert.deepEqual(Object.keys(row.logs.klippy.counts).sort(), vocabulary)
  assert.doesNotMatch(
    output,
    /No communication with MCU|identify_response|Unable to open serial port|entered RUNNING state|exit status|ttyACM0/,
  )
})

test('excludes configuration and macro text while keeping genuine exception lines', () => {
  const { output, rows } = collectWithLogs({
    klippy: [
      '[config] No communication with MCU',
      '#macro No communication with MCU',
      '  No communication with MCU',
      'No communication with MCU SECRET_MARKER',
      'Traceback (most recent call last):',
      '  File "/home/printer/klipper/klippy/serialhdl.py", line 512, in get_response',
      "error: mcu 'mcu': Unable to obtain 'identify_response' response",
    ].join('\n'),
    supervisord: [
      '2026-11-05 10:00:00,000 INFO exited: notaprogram (exit status 1; not expected)',
      '2026-11-05 10:00:01,000 INFO success: notaprogram entered RUNNING state, process has stayed up for > than 5 seconds (startsecs)',
    ].join('\n'),
  })
  const counts = rows[0].logs.klippy.counts
  assert.equal(counts['mcu-no-communication'], 1)
  assert.equal(counts['identify-response-error'], 1)
  assert.equal(counts['traceback'], 1)
  assert.equal(rows[0].logs.supervisord.counts['supervisor-process-exited'], 0)
  assert.equal(rows[0].logs.supervisord.counts['supervisor-process-running'], 0)
  assert.doesNotMatch(output, /SECRET_MARKER|notaprogram/)
})

test('bounds captured events and numeric stats with the new classifications', () => {
  const { rows } = collectWithLogs({
    klippy: `${Array.from({ length: 25 }, () => 'No communication with MCU').join('\n')}
${Array.from(
  { length: 8 },
  (_, index) => `Stats ${index}.0: bytes_read=42 bytes_invalid=3 freq=1000`,
).join('\n')}
`,
  })
  const summary = rows[0].logs.klippy
  assert.equal(summary.counts['mcu-no-communication'], 25)
  assert.equal(summary.events.length, 20)
  assert.equal(summary.stats.length, 5)
  assert.ok(
    summary.events.every((event: unknown) => event === 'mcu-no-communication'),
  )
  assert.equal(summary.stats[0].at, 3)
  assert.equal(summary.stats[4].at, 7)
})

test('rejects invalid project names before invoking Docker', () => {
  const run = spawnSync(process.execPath, [script, 'bad!'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /Invalid Compose project/)
})

for (const { name, quota, pressure } of [
  { name: 'malformed', quota: 'secret-token', pressure: 'secret-token' },
  {
    name: 'overflow',
    quota: '9007199254740992 100000',
    pressure: 'some avg10=101.00 avg60=0.00 avg300=0.00 total=1',
  },
  {
    name: 'duplicate',
    quota: '200000 100000\n200000 100000',
    pressure:
      'some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nsome avg10=0.00 avg60=0.00 avg300=0.00 total=1',
  },
]) {
  test(`reports ${name} scheduling data unavailable without echoing it`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'open3d-diag-test-'))
    try {
      writeFileSync(join(dir, 'quota'), quota)
      writeFileSync(join(dir, 'pressure'), pressure)
      writeFileSync(
        join(dir, 'docker'),
        `#!/bin/sh
case "$*" in
  *"ps -aq"*) echo aaaaaaaaaaaa ;;
  *"cpu.max"*) cat '${dir}/quota' ;;
  *"cpu.pressure"*) cat '${dir}/pressure' ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o700 },
      )
      const run = spawnSync(process.execPath, [script], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: 'utf8',
        timeout: 10000,
      })
      assert.equal(run.status, 0)
      assert.doesNotMatch(run.stdout + run.stderr, /secret-token/)
      const rows = run.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      for (const row of rows) {
        assert.equal(row.cpuQuota, 'unavailable')
        assert.equal(row.cpuPressure, 'unavailable')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('preserves unlimited quota and all-zero pressure without trailing newlines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-diag-test-'))
  try {
    writeFileSync(join(dir, 'quota'), 'max 100000')
    writeFileSync(
      join(dir, 'pressure'),
      'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0',
    )
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh
case "$*" in
  *"ps -aq"*) echo aaaaaaaaaaaa ;;
  *"cpu.max"*) cat '${dir}/quota' ;;
  *"cpu.pressure"*) cat '${dir}/pressure' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 },
    )
    const run = spawnSync(process.execPath, [script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(run.status, 0)
    const rows = run.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.deepEqual(row.cpuQuota, { quotaUsec: null, periodUsec: 100000 })
      const zero = { avg10: 0, avg60: 0, avg300: 0, totalUsec: 0 }
      assert.deepEqual(row.cpuPressure, { some: zero, full: zero })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
