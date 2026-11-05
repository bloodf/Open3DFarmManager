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
    quota: '0 100000',
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
