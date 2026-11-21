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

`quiet` and `loaded` put `/tmp` on tmpfs. `overlay` keeps it on the overlay
filesystem. `disk` adds background fsync writers, `stress` adds them together
with CPU spinners on one CPU. `--test-timeout MS` forces a timeout without load
to show the isolation fix deterministically: before it, one timeout produced
`Queue clock regressed`; after it, the timeout is reported alone.

## Gate guidance

Run the container with `--tmpfs /tmp:rw,mode=1777` so durable test fixtures do
not depend on host disk latency. Do not raise timeouts to hide shared-load
effects.
