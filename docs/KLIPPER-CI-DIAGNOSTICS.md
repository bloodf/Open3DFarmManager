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
establish why an MCU missed a deadline. The existing simulator failure remains
unresolved; no timing, privilege, readiness condition or command path changed.

The collector is intended only for the isolated synthetic Compose services.
Synthetic tests exercise its redaction and the local runner's failure-status and
cleanup paths without starting Docker or a printer:

```sh
node --test tests/node/klipper-diagnostics.test.ts
bash scripts/test-local-ci.sh
```
