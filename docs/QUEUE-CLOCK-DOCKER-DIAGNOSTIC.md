# Queue clock and timeout diagnostic in Docker

The Node 22 Docker final gate for the built-in spool library reported
`Queue clock regressed` errors and many 5 s test timeouts. This records what
each one is. Reproduce with `node scripts/test-queue-clock-docker.mjs`; it runs
only the focused files, with no network and no printer, and writes a JSON
summary per profile to a bounded evidence directory.

## Findings

| Symptom                                                                                         | Cause                                                                                                                                                                                                                                                                                 | Product defect?                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `mixed-telemetry-runtime`: five 5 s timeouts, then four unhandled `Queue clock regressed`       | The tests take 0.2–0.7 s alone. Under shared CPU and disk load (profile `stress`) four of five pass the 5 s limit. A timed-out body keeps running while Vitest starts the next test, so it advanced and then restored the next test's fake clock, which moved `Date.now()` backwards. | No. The queue correctly refuses a backwards clock. The defect was test isolation, fixed in the test. |
| `heartbeat-coalesce`, `telemetry-scope-handover`, `configuration-inventory-runtime`, and others | Each queue append fsyncs. On the container overlay filesystem backed by a contended host disk, fsync costs 5–25 ms (1440 appends: about 44 s); on tmpfs the same appends take 0.3 s. The queue itself costs 0.2 ms per append.                                                        | No. Durable appends are the contract. The cost is the disk under test.                               |
| Browser-dependent files                                                                         | Chrome is missing from the image.                                                                                                                                                                                                                                                     | Image work, tracked separately.                                                                      |

## Evidence runner profiles

`loaded` is the focused gate command: `node scripts/test-queue-clock-docker.mjs --profile loaded`.
It puts `/tmp` on tmpfs and starves the container with CPU spinners, then runs
the focused files with their normal timeouts. `quiet` is the same without load.
`isolation` forces a short test timeout (`--test-timeout MS`, default 150) and
passes only if no timeout leaks into a later test as `Queue clock regressed`.
`gate` runs these three.

`overlay`, `disk` and `stress` are diagnostics, run only when named or with
`all`. `overlay` keeps `/tmp` on the host disk (a run-directory bind mount) so each
fsync reaches the shared disk; `disk` adds background fsync writers; `stress` adds them with
CPU spinners on one CPU. Their outcome depends on the host disk, so they are not
a gate. Each profile has a wall-clock limit (`--profile-timeout`).

The isolation fix is in the test: when a test times out, an `afterEach` stops
its collector and restores timers, and its body stops advancing the clock.

## Gate guidance

Run the container with `--tmpfs /tmp:rw,mode=1777` so durable test fixtures do
not depend on host disk latency. Do not raise timeouts to hide shared-load
effects.
