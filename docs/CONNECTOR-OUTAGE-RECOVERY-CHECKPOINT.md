# Connector outage and restart recovery checkpoint

Issue #6 (E3). `pnpm run test:connector-outage` (`scripts/test-connector-outage-recovery.ts`) runs one integrated, reproducible acceptance of the Connector's durable telemetry path across server outages and its own restarts. It contributes the "outage and recovery, bounded telemetry drain" evidence required by [PHASE-0.md](PHASE-0.md); it is not the combined Phase 0 acceptance.

## What runs

- A fresh, disposable, digest-pinned PostgreSQL 17 container (read-only root, tmpfs data, all capabilities dropped, loopback port), migrated to the current catalog. The runner never pulls an image or accepts a database URL, and removes only its own container, verified by ID, name and label.
- The built farm server (`apps/farm/.output`) with the database phase gate in `verify` mode and the connector telemetry runtime enabled under a dedicated `farm_connector_telemetry_writer` role.
- Real enrollment through the maintained pairing, proof, approval, credential claim and printer-assignment storage. No synthetic token.
- The real Connector CLI process (`run`) with its own identity, scoped durable queue and authenticated HTTPS sender. A private loopback CA is trusted through `NODE_EXTRA_CA_CERTS`; TLS verification stays on.
- A synthetic loopback Moonraker that pushes `notify_status_update` progress changes. No physical printer is contacted.
- A loopback TLS proxy in front of the server that records every attempt and injects connection resets or withholds one successful commit response.

## Admission

```sh
pnpm --dir apps/farm build
OUTAGE_TEST_ADMITTED=yes \
OUTAGE_TEST_IMAGE='postgres:17@sha256:<digest>' \
OUTAGE_TEST_PORT_BASE=<port> \
OUTAGE_TEST_WORK_ROOT=<absolute directory outside the repository> \
pnpm run test:connector-outage
```

The runner uses ports `base` to `base + 3` (PostgreSQL, server, TLS proxy, Moonraker). `OUTAGE_TEST_NAME_PREFIX` (default `o3dfm-outage`) prefixes the container name. Each run writes `<id>.ledger.jsonl` (every role, container, process and listener it created) and `<id>.result.json` to the work root. The run directory holds synthetic keys and credentials. It is removed after a successful run and kept as evidence after a failure.

## Scenarios

| Scenario                               | Fault                                                                                              | Checked                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Server process down                 | Server stopped while the printer changes state; graceful Connector restart during the outage       | Records persist across the restart; retries continue with gaps of at most `timeoutMs + retryMaxMs` plus slack; the full queue drains after the server returns and the Connector process stays up.                    |
| 5. Network blip shorter than backoff   | Proxy resets connections for one attempt (about 200 ms)                                            | One retained attempt, then recovery within one backoff and no loss.                                                                                                                                                  |
| 2. Database unavailable, startup gate  | PostgreSQL frozen (`docker pause`); server restarted while frozen                                  | The Connector observes the gate's 503 and keeps a bounded backoff; after PostgreSQL returns the gated server becomes ready and telemetry drains.                                                                     |
| 3. SIGKILL after commit, before ack    | Proxy withholds a committed 200 response; the Connector is killed with SIGKILL                     | Records are committed once but remain queued; restart replays the same event IDs, the server accepts the replay idempotently and every ID stays at exactly one row.                                                  |
| Exactly-once and order                 | All of the above                                                                                   | Database rows equal every observation the fixture caused (including each restart's new baseline snapshot), each exactly once; every sent event ID is stored; first-delivery order is FIFO and per-printer monotonic. |
| 4. Queue cap during a long outage      | Server down; queue pre-filled to the documented 50 MiB cap with canonical records, then new states | Oldest records are evicted first, a retention `loss` diagnostic reports the count, newer records are kept, the Connector does not crash and the drain resumes from the oldest retained record.                       |
| 6. Credential renewal across an outage | Not run                                                                                            | Not implemented yet. Server renewal activation landed in #132 after this runner was written, so renewal across an outage is a follow-up scenario.                                                                    |

## Defect fixed

The first run failed scenario 2. A server started while PostgreSQL was unreachable passed the database gate once PostgreSQL returned, but its telemetry runtime had tried to activate once, failed, and stayed disabled: every telemetry request answered 503 until a process restart. The telemetry plugin now retries activation until it succeeds or the server closes, and never blocks startup. An unreachable database (connection errors, SQLSTATE class 08, 57P01 to 57P03, 53300, 57014) is retried with capped backoff from 1 s to 30 s. A rejected configuration (role or key file) is retried only at the 30 s maximum. The fixed failure class is reported on the first failure and on each change. `tests/unit/telemetry-runtime-bootstrap.test.ts` covers retry until success, slowdown after rejection, reporting and cancellation.

## Findings not fixed here

- **Stale queue lock after a crash.** After SIGKILL the Connector cannot restart (exit 1) because `telemetry.lock` remains. Scenario 3 performs the documented operator step: it confirms the lock names the killed and reaped PID, removes that exact file and restarts. Unattended crash recovery needs a supervised lock-ownership design (PID liveness alone is unsafe across PID reuse and namespaces), which is a separate change to the queue.
- **Full-queue drain rate.** Each acknowledgement rewrites and fsyncs the entire queue file. With a full 50 MiB queue (about 265 000 records) the measured drain was 33 to 44 records/s across runs, so a full backlog would take roughly two hours to clear. The drain is bounded and makes progress, but its cost grows with backlog size. Keeping the backlog drainable in proportion to its size needs an acknowledgement format that does not rewrite the log (for example a durable head offset with periodic compaction).

## Results

Three consecutive passing runs on `cortexos` (Ubuntu amd64, Node 24.22.2, Docker 29, host load average 15 to 25) after review hardening, with `postgres:17@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`:

| Run | Total | S1 (drain / max retry gap) | S5 recovery | S2 (503s / max gap) | S3 (replays) | Rows | S4 (evicted / reopen / drain rate) |
| --- | ----- | -------------------------- | ----------- | ------------------- | ------------ | ---- | ---------------------------------- |
| 8   | 83 s  | 12.0 s (1.7 s / 1.98 s)    | 1.80 s      | 16.4 s (1 / 3.6 s)  | 6.2 s (1)    | 25   | 40.0 s (5 / 4.8 s / 43 rec/s)      |
| 9   | 94 s  | 12.3 s (2.0 s / 1.74 s)    | 1.80 s      | 16.0 s (1 / 3.8 s)  | 6.1 s (1)    | 25   | 40.7 s (5 / 5.3 s / 44 rec/s)      |
| 10  | 95 s  | 11.7 s (1.6 s / 1.93 s)    | 1.85 s      | 15.8 s (1 / 3.7 s)  | 6.1 s (1)    | 25   | 39.3 s (5 / 4.8 s / 43 rec/s)      |

Each run removed its container, roles, processes, listeners and run directory (`cleanup: complete`). Timings are wall clock on a shared host. Retry gaps stayed within the configured bounds (`timeoutMs` 3000, `retryMinMs` 500, `retryMaxMs` 2000).

Run history: run 1 failed scenario 2 before the telemetry activation fix. Runs 2 to 4 passed (drain rate 33 to 39 records/s at the higher load at that time). After review hardening, run 6 failed during database startup: the image's init-time server answered the socket readiness probe and then restarted, resetting the first TCP connection. Readiness now probes TCP inside the container. Runs 5 and 7 to 10 passed.
