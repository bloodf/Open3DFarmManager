#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Diagnostic output deliberately excludes raw logs, configuration and container environment.
import { spawnSync } from 'node:child_process'
import { availableParallelism, loadavg } from 'node:os'

const project = process.argv[2]
if (
  process.argv.length > 3 ||
  (project && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))
) {
  console.error('Invalid Compose project')
  process.exit(2)
}
const compose = [
  'compose',
  ...(project ? ['-p', project] : []),
  '-f',
  'infra/sim/docker-compose.yml',
]
function docker(args, includeStderr = false, acceptNonzero = false) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 128 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || (!acceptNonzero && result.status !== 0)) return null
  return result.stdout + (includeStderr ? result.stderr : '')
}
// Only the programs declared by the pinned Supervisor configuration are
// classified, and the emitted counts never carry a program name.
const supervisorPrograms = ['klipper', 'moonraker', 'simulavr', 'webcamd']
const supervisorProgramPattern = supervisorPrograms.join('|')
const supervisorStatusPattern = new RegExp(
  `^(${supervisorProgramPattern})\\s+(RUNNING|STARTING|BACKOFF|STOPPING|EXITED|FATAL|UNKNOWN)\\b`,
)
// Every label below matches a literal emitted by the pinned Klipper revision
// ee2c6fb or by Supervisor 4.2.5. A count reports that a captured line
// contained the literal, not the cause behind it.
const patterns = [
  [
    'identify-timeout',
    /timeout.*(?:connect|identif)|(?:connect|identif).*timeout/i,
  ],
  ['mcu-connect', /mcu ['"]?mcu['"]?: starting serial connect/i],
  ['mcu-identify', /loaded mcu|mcu ['"]?mcu['"]?: got/i],
  ['timer-too-close', /timer too close/i],
  [
    'shutdown',
    /^(?:transition to shutdown state:|mcu .*shutdown:|shutdown due to)/i,
  ],
  [
    'communication-error',
    /unable to connect|lost communication|communication timeout/i,
  ],
  ['traceback', /traceback \(most recent call last\)/i],
  // serialhdl.SerialReader.raw_send_wait_ack raising on a missing MCU reply.
  ['mcu-no-communication', /no communication with mcu\b/i],
  // serialhdl.SerialRetryCommand.get_response after its retry budget.
  [
    'identify-response-error',
    /unable to obtain ['"]identify_response['"] response\b/i,
  ],
  // serialhdl.connect_uart warning when the serial port cannot be opened.
  ['serial-port-error', /unable to open serial port\b/i],
  // Supervisor process lifecycle, restricted to the allowlisted programs.
  [
    'supervisor-process-exited',
    new RegExp(
      `\\bexited: (?:${supervisorProgramPattern}) \\((?:exit status [0-9]+|terminated by SIG[A-Z]+)`,
      'i',
    ),
  ],
  [
    'supervisor-process-running',
    new RegExp(
      `\\b(?:${supervisorProgramPattern}) entered RUNNING state\\b`,
      'i',
    ),
  ],
]
const counterKeys = new Set([
  'bytes_write',
  'bytes_read',
  'bytes_retransmit',
  'bytes_invalid',
  'freq',
  'print_stall',
  'sysload',
  'cputime',
])
function summarize(input) {
  const counts = Object.fromEntries(patterns.map(([name]) => [name, 0]))
  const stats = []
  const events = []
  for (const line of input.split('\n')) {
    // Ignore config and macro text; only classify recognizable runtime log lines.
    if (/^\s|^\[|^#/u.test(line)) continue
    for (const [name, pattern] of patterns)
      if (pattern.test(line)) {
        counts[name]++
        events.push(name)
      }
    if (/^Stats \d+(?:\.\d+)?: /.test(line)) {
      const time = /^Stats (\d+(?:\.\d+)?):/.exec(line)
      const sample = { at: Number(time[1]) }
      for (const token of line.split(/\s+/)) {
        const match = /^([a-z_]+)=([0-9]+(?:\.[0-9]+)?)$/.exec(token)
        if (match && counterKeys.has(match[1]))
          sample[match[1]] = Number(match[2])
      }
      stats.push(sample)
    }
  }
  return { counts, events: events.slice(-20), stats: stats.slice(-5) }
}
function cpu(input) {
  const result = {}
  for (const line of input.split('\n')) {
    const match =
      /^(usage_usec|nr_periods|nr_throttled|throttled_usec) (\d+)$/.exec(line)
    if (match) result[match[1]] = Number(match[2])
  }
  return ['usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'].every(
    (key) => Object.hasOwn(result, key),
  )
    ? result
    : 'unavailable'
}
function cpuQuota(input) {
  const match = /^(max|[1-9][0-9]*) ([1-9][0-9]*)\n?$/.exec(input)
  if (!match) return 'unavailable'
  const periodUsec = Number(match[2])
  const quotaUsec = match[1] === 'max' ? null : Number(match[1])
  if (
    !Number.isSafeInteger(periodUsec) ||
    (quotaUsec !== null && !Number.isSafeInteger(quotaUsec))
  )
    return 'unavailable'
  return { quotaUsec, periodUsec }
}
function cpuPressure(input) {
  const result = {}
  for (const line of input.trim().split('\n')) {
    const match =
      /^(some|full) avg10=([0-9]+\.[0-9]+) avg60=([0-9]+\.[0-9]+) avg300=([0-9]+\.[0-9]+) total=([0-9]+)$/.exec(
        line,
      )
    if (!match || Object.hasOwn(result, match[1])) return 'unavailable'
    const averages = match.slice(2, 5).map(Number)
    const totalUsec = Number(match[5])
    if (
      averages.some((value) => !Number.isFinite(value) || value > 100) ||
      !Number.isSafeInteger(totalUsec)
    )
      return 'unavailable'
    result[match[1]] = {
      avg10: averages[0],
      avg60: averages[1],
      avg300: averages[2],
      totalUsec,
    }
  }
  return Object.hasOwn(result, 'some') ? result : 'unavailable'
}
// Sampled only after failure; host load includes unrelated runner activity.
const host = {
  availableParallelism: availableParallelism(),
  loadavg: loadavg(),
}
for (const service of ['sv06', 'u1']) {
  const ids = docker([...compose, 'ps', '-aq', service])
  const id = ids?.trim()
  if (!id || !/^[a-f0-9]{12,64}$/.test(id)) {
    console.log(JSON.stringify({ service, container: 'unavailable' }))
    continue
  }
  const state = docker([
    'inspect',
    '--format',
    '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}',
    id,
  ])?.trim()
  const container =
    /^(created|running|paused|restarting|removing|exited|dead) \d+ (true|false)$/.test(
      state ?? '',
    )
      ? state
      : 'unavailable'
  const supervisor = docker(
    ['exec', id, 'supervisorctl', 'status'],
    false,
    true,
  )
  const processes = {}
  if (supervisor !== null) {
    for (const line of supervisor.split('\n')) {
      const match = supervisorStatusPattern.exec(line)
      if (match) processes[match[1]] = match[2]
    }
  }
  const logs = {}
  for (const name of ['klippy', 'moonraker', 'supervisord']) {
    const log = docker([
      'exec',
      id,
      'tail',
      '-c',
      '65536',
      `/home/printer/printer_data/logs/${name}.log`,
    ])
    logs[name] = log === null ? 'unavailable' : summarize(log)
  }
  const stdout = docker(['logs', '--tail', '150', id], true)
  const cgroup = docker(['exec', id, 'cat', '/sys/fs/cgroup/cpu.stat'])
  const quota = docker(['exec', id, 'cat', '/sys/fs/cgroup/cpu.max'])
  const pressure = docker(['exec', id, 'cat', '/sys/fs/cgroup/cpu.pressure'])
  console.log(
    JSON.stringify({
      service,
      container,
      processes: supervisor === null ? 'unavailable' : processes,
      logs,
      stdout: stdout === null ? 'unavailable' : summarize(stdout),
      cpu: cgroup === null ? 'unavailable' : cpu(cgroup),
      host,
      cpuQuota: quota === null ? 'unavailable' : cpuQuota(quota),
      cpuPressure: pressure === null ? 'unavailable' : cpuPressure(pressure),
    }),
  )
}
