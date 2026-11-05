# Klipper CI failure diagnostics

The simulator job still requires SV06 to become connected and ready within the
existing 90-second smoke deadline. A failure runs
`scripts/klipper-diagnostics.mjs` before Compose cleanup. The local CI runner
uses the same collector and retains its output in `simulator-failure.log` in the
external task ledger. The collector cannot turn a failed smoke or startup into a
pass; the local runner returns the original failing command's status.

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

The collector now also records Node's available parallelism and three host
load averages, plus each container's effective cgroup v2 CPU quota and CPU
pressure averages/cumulative microseconds. These are post-failure samples;
host load includes unrelated processes, and pressure averages are not a
continuous startup trace. Unavailable, malformed, duplicate or overflowing
pressure/quota input is reported unavailable without printing the raw text.
No CPU limit, readiness criterion, simulator code or retry policy changes.

The collector is intended only for the isolated synthetic Compose services.
Synthetic tests exercise its redaction and the local runner's failure-status and
cleanup paths without starting Docker or a printer:

```sh
node --test tests/node/klipper-diagnostics.test.ts
bash scripts/test-local-ci.sh
```
