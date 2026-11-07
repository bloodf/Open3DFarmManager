# Klipper CI failure diagnostics

The simulator job still requires SV06 to become connected and ready within the
existing 90-second smoke deadline. A failure runs
`scripts/klipper-diagnostics.mjs` before Compose cleanup. The local CI runner
uses the same collector and writes its output to `simulator-failure.log` inside
the fresh evidence ledger it creates under `TMPDIR`, then prints that ledger
path. The ledger is temporary, so the file does not reach a persistent task
ledger. The collector cannot turn a failed smoke or startup into a pass; the
local runner returns the original failing command's status.

For each synthetic service, it reports the container state, exit and OOM flags,
known Supervisor process states, recent Klipper, Moonraker and Supervisor log
classifications, selected numeric Klipper counters, and cgroup v2 CPU counters
when available. It also classifies bounded Docker stdout and stderr. It does
not print raw log lines, configuration, environment variables, addresses or
credentials. Each Docker call has a four-second limit and a 128 KiB output
limit; application log reads take only the last 64 KiB. The last five numeric
`Stats` records include Klipper's monotonic timestamps. Classification counts
and event ordering cover only the captured tails, not the whole run.

A stopped container cannot be queried with `docker exec`: its file logs and
Supervisor state are reported unavailable, while container state and Docker
output may still be available. Missing files, unsupported cgroup layouts,
Docker errors, timeouts or oversized output are reported as unavailable rather
than silently presented as zero. Counters are aggregate observations and do not
establish why an MCU missed a deadline.

## What the classifications observe

Every classification is a fixed label with a bounded count over the captured
tail. A label reports a match against its fixed log pattern, which may match
several messages. A match does not establish the underlying cause.

The runtime exception and warning labels match literals from the pinned
Klipper revision `ee2c6fb`:

| classification            | matched literal                                 | source                                                                              |
| ------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `mcu-no-communication`    | `No communication with MCU`                     | `klippy/serialhdl.py`, `raw_send_wait_ack` raising when the MCU did not acknowledge |
| `identify-response-error` | `Unable to obtain 'identify_response' response` | `klippy/serialhdl.py`, `SerialRetryCommand.get_response` after its retry budget     |
| `serial-port-error`       | `Unable to open serial port`                    | `klippy/serialhdl.py`, `connect_uart` warning when the port could not be opened     |

The Supervisor lifecycle labels match literals from Supervisor 4.2.5, and only
for the four programs in the pinned Supervisor configuration (`klipper`,
`moonraker`, `simulavr`, `webcamd`):

| classification               | matched literal                                                                 | source                                           |
| ---------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `supervisor-process-running` | `<program> entered RUNNING state`                                               | `supervisor/process.py`, `Subprocess.transition` |
| `supervisor-process-exited`  | `exited: <program> (exit status N` or `exited: <program> (terminated by SIG...` | `supervisor/process.py`, `Subprocess.finish`     |

The program names are part of the pattern, so a line about any other program
stays unclassified. Counts carry no program name, PID, exit status, signal,
path or exception payload.

A label reports an observed exception and stops there.
`mcu-no-communication` records that the log held that exception text. The same
evidence fits an MCU that never answered, an answer that was rejected, a host
or emulator too slow to use the deadline, and a PTY that was wrong or absent.
`identify-response-error` records that the identify response did not arrive
within its retry budget, and it says nothing about how many bytes reached the
MCU. `serial-port-error` records a warning from `connect_uart`, so it says the
port could not be opened and nothing about why.

A Supervisor `RUNNING` state is a liveness signal. Supervisor reports it for a
process that started and stayed up, including one that stopped serving its
UART.

The emulator start banner (`Starting AVR simulation: machine=...`) is not
classified. Its routing in the pinned image has not been established by this
collector: an external diagnosis suggests container stdout, while the proposed
implementation assumed a Supervisor child log. Neither assumption justifies
claiming that the banner is absent or unreachable. Verify the actual image's
configuration and captured output before adding this measurement; no additional
Docker reads are introduced here.

None of these labels changes the 90-second deadline, and none of them claims
that a simulator became ready.

## Missing in-session evidence

An empty `stats` array means that no line matching the collector's `Stats`
pattern was captured. A matching line without recognized counters still emits
an object containing `at`; it does not emit an empty array. Thus `stats: []`
does not itself establish why statistics were missing. Klipper's
`serialhdl.SerialReader.stats()` returns an empty string once `serialqueue`
is `None`, but the captured tails do not prove how that behavior affected the
upstream log emitter. Missing `bytes_read` and `bytes_invalid` remain absent
measurements, not zeros.

An absent counter leaves two failures indistinguishable. Without
`bytes_read` the collector cannot separate an MCU that never answered from an
MCU whose answer arrived. Without `bytes_invalid` it cannot separate a
rejected response from a missing one. The new labels narrow the window by
naming the exception that was logged, and the root cause stays open until a
run captures traffic counters or an in-process observer.

In [CI run 42054032381](https://github.com/bloodf/Open3DFarmManager/actions/runs/42054032381/job/127338415048),
SV06 failed the 90-second readiness probe with one CPU per simulator. A fresh
comparison on the same runner, image and configuration with two CPUs per
simulator passed the same SV06 probe in 22.324 seconds. Both simulators logged
MCU identification without an identify timeout, timer-too-close or shutdown;
U1 was not explicitly probed for readiness. CPU throttling fell from about
48/47 seconds for SV06/U1 to 0.023/0.003 seconds. This is one comparison, not
evidence of long-term stability. The normal job subsequently passed at
`60a702b`, but [run 42062376996](https://github.com/bloodf/Open3DFarmManager/actions/runs/42062376996/job/127367288995)
failed again at `2913588` with the same two-CPU configuration. Both emulators
were running, neither MCU identified, and the captured tails contained 15/14
identify timeouts. Throttling was only 0.015/0.171 seconds for SV06/U1 over the
roughly 90-second window. That failure cannot be attributed to heavy quota
throttling from these counters alone.

The collector also records scheduling observations. The simulator job passed at
`1a8b885`, so its failure-only collector did not run. Subsequently,
[run 42071575582](https://github.com/bloodf/Open3DFarmManager/actions/runs/42071575582/job/127401307214)
at `8156420` failed readiness and exercised the new collector against real
container cgroups. Both visible quotas were 200000/100000 microseconds (2 CPU
units). Host available parallelism was 4, with load averages 3.05/1.24/0.47.
SV06/U1 reported CPU `some.avg10` of 0.94/1.54 percent and `full.avg10` of
0.41/0.44 percent. Quota throttling was 0.017/0.181 seconds. Both MCU identify
counts remained zero, with 15/14 identify timeouts in the captured tails.

This establishes one real collection of the fields, not simulator acceptance or
a scheduling root cause. Low sampled pressure and throttling do not justify
increasing CPU allocation or extending the deadline. Checks passed; the
simulator readiness check remains failed.

On the supported Linux CI host, `loadavg` contains the 1-, 5- and 15-minute
averages of runnable or uninterruptible tasks, as absolute counts, not percentages
or values normalized by CPU count. It includes unrelated work. Node's
`availableParallelism` is an estimate of parallelism available to the process,
not a measurement of container CPU quota. Dividing load by this estimate does
not establish the cause of a simulator failure. Windows load averages are
unsupported and return zeros; these must not be interpreted as an idle host.

`cpuQuota` reports the visible cgroup v2 `cpu.max` quota and period in
microseconds. `quotaUsec: null` means `max` (no limit at this level). For a finite
quota, quota divided by period expresses CPU time allowed per period in CPU
units, not actual utilization or guaranteed capacity. The container path assumes
the usual private cgroup namespace; a host namespace or altered mount can expose
a different cgroup. Ancestor limits are not collected.

CPU pressure `avg10`, `avg60` and `avg300` are stall-time percentages over 10, 60
and 300 seconds; `totalUsec` is cumulative stall time in microseconds. `some`
means at least one task is stalled and `full` means all non-idle tasks are
stalled. These are post-failure samples, not a continuous startup trace.
Unavailable, malformed, duplicate or overflowing pressure/quota input is
reported unavailable without printing raw text. No CPU limit, readiness
criterion, simulator code or retry policy changes.

See the [Node OS API](https://nodejs.org/api/os.html) and
[Linux pressure documentation](https://docs.kernel.org/accounting/psi.html).

The collector is intended only for the isolated synthetic Compose services.
Synthetic tests exercise its redaction and the local runner's failure-status and
cleanup paths without starting Docker or a printer:

```sh
node --test tests/node/klipper-diagnostics.test.ts
bash scripts/test-local-ci.sh
```

## Current-head remote classification evidence

[Simulator run 42083752172](https://github.com/bloodf/Open3DFarmManager/actions/runs/42083752172)
at `9c87157` exercised the new classifications on a real CI failure. SV06/U1
recorded 15/14 identify timeouts and MCU no-communication exceptions, 1/2
serial-port opening errors and zero identify-response errors. Each captured
Supervisor log contained four RUNNING events and no exit events. Container
stdout repeated those lifecycle observations; they must not be counted as
additional starts. Captured tails are not exhaustive process histories.

Both `stats` arrays were empty. The unchanged 90-second readiness gate failed;
code and image checks passed. These observations validate remote diagnostic
collection, not a cause, stable readiness or printing acceptance. The next
measurement needs bounded observation inside an identification session before
its serial queue is destroyed.
