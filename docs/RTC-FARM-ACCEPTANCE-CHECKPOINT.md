# Real-RTC farm-page acceptance checkpoint

Issues #8 and #9. `pnpm run test:rtc-farm` (`scripts/test-rtc-farm-acceptance.ts`) runs the real-RTC farm-page acceptance in one command. Before this runner existed, the same scenario (`scripts/test-signalling-https.ts` with `SIGNALLING_HTTPS_FARM_PAGE=yes`) needed a hand-built disposable PostgreSQL, a sealed build layer, a CA and a private ledger, and none of that was documented. This runner is the base of the combined Phase 0 acceptance; pause and camera rows plug into it (see [Adding rows](#adding-rows)).

## What runs

- A fresh, disposable, digest-pinned PostgreSQL 17 container: read-only root, tmpfs data, all capabilities dropped, `--pull never`, a fixed loopback port. It is migrated to the current catalog. The runner never accepts a database URL or an existing container. It removes only its own container, verified by ID and label.
  - The container uses `POSTGRES_HOST_AUTH_METHOD=trust`. That is acceptable only because the port is published on `127.0.0.1` only, the cluster lives in tmpfs with synthetic rows, and it is removed at the end of the run. Do not reuse this configuration elsewhere.
- A sealed build of the farm server with the connector signalling runtime enabled. The steps are `nuxt prepare` for the app types, `test-signalling-https.ts --prepare-layer`, `nuxt build` and `--seal-build`. Everything is written to a `0700` work directory outside the checkout.
- One fresh `test-signalling-https.ts --run` per scenario row. Each run has its own restricted roles, accounts, farm and enrollment. It generates a throwaway TLS certificate and signing keys inside the work directory (via `TMPDIR`) and trusts them only through `NODE_EXTRA_CA_CERTS`; TLS verification stays on for Node. The built server runs behind a loopback HTTPS/WSS proxy.
- The real Connector agent with native `node-datachannel` WebRTC, admitted through authenticated signalling. A synthetic loopback Moonraker answers the subscription and the complete-observation (temperature) query. No physical printer is contacted.
- Playwright Chromium on the real farm page (`/farm`). It logs in through the built app, approves the browser key, pairs and assigns the Connector, and reads live status over WebRTC.

## Admission

```sh
RTC_FARM_TEST_ADMITTED=yes \
RTC_FARM_TEST_IMAGE='postgres:17@sha256:<digest>' \
RTC_FARM_TEST_DB_PORT=<loopback port> \
RTC_FARM_TEST_WORK_ROOT=<absolute directory outside the repository> \
pnpm run test:rtc-farm
```

| Variable                    | Meaning                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `RTC_FARM_TEST_IMAGE`       | Digest-pinned PostgreSQL 17 image, already present locally (never pulled).                                    |
| `RTC_FARM_TEST_DB_PORT`     | Loopback port for the container. The server, proxy and Moonraker use OS-assigned loopback ports.              |
| `RTC_FARM_TEST_WORK_ROOT`   | Private parent directory. Each run creates `<root>/<id>` (`0700`) and removes exactly that path in `finally`. |
| `RTC_FARM_TEST_SCENARIOS`   | Optional comma list of rows. Default: every row.                                                              |
| `RTC_FARM_TEST_REPEAT`      | Optional repeat count (1–5) of the selected rows against one cluster and build.                               |
| `RTC_FARM_TEST_NAME_PREFIX` | Optional container name prefix (default `o3dfm-rtc-farm`).                                                    |

Prerequisites:

- Linux or macOS with Docker and Node 24, and `pnpm install --frozen-lockfile`. The `@node-datachannel/*` platform package provides the native binary, so no install script is needed.
- `pnpm exec playwright install chromium`.
- A clean checkout: the sealed build hashes the tracked sources.
- About 4 GiB free.

Evidence goes to `~/.local/state/o3dfm/rtc-farm-tests/<id>/`:

- `resources.jsonl`: the container, work directory, every owned process group, and each removal.
- One log per step and row.
- Each row's sanitized ledger, RTC resource ledger and app log.

Every child process gets an allowlisted environment: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `PLAYWRIGHT_BROWSERS_PATH`, `XDG_CACHE_HOME`, plus `TMPDIR` set to the work directory and the row's opt-ins. The caller's other variables, including `NODE_TLS_REJECT_UNAUTHORIZED`, never reach them.

Each step runs as its own process group with a timeout. On timeout the group gets SIGTERM, then SIGKILL after 5 s. Step logs are drained on `close` and capped at 8 MiB each.

Signals:

- The first SIGINT/SIGTERM stops the current group, and `finally` removes the container and work directory.
- A second signal kills the group, removes the container by name and the exact work directory synchronously, and exits with 130.

On cortexos, both a single SIGTERM and a double SIGTERM left no container, no work directory and no fixture processes.

## Rows

| Row                    | Flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farm-page-disconnect` | Login → paired Connector → farm view shows "Conexão direta autenticada" and live progress over WebRTC (0.25 → 0.75). Then the signalling connections drop: the row turns read-only within 10 s (`farm-page-readonly-after-ms`), keeps the last observation, and the pause button stays disabled. Recovery (#121): the view re-checks authority and reopens while the Connector reconnects. Live status returns (`farm-page-recovered-after-ms`, measured from the drop), and a new fixture observation (0.9) reaches the page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `farm-page-pause`      | Same as `farm-page-disconnect`, with pause control enabled on the server (pause authority issuer key) and on the composed Connector (`pause.control` for the assignment, `SIGNALLING_HTTPS_FARM_PAUSE=yes`). While live and printing, **Pausar impressão** is enabled. After the drop it is disabled with "Pausa indisponível. Não há conexão direta ao vivo." and no pause is sent. After recovery, the row first waits until the Connector has re-admitted its pause inbox: a dialog opened before then fails closed by design. Then the page opens the dialog and waits for "Autorização pronta". Nothing is sent before **Confirmar pausa**. The confirmed command goes over WebRTC to the Connector, and the synthetic Moonraker receives **exactly one** `printer.print.pause`. The dialog shows "Impressão pausada. O Connector confirmou a pausa." (`farm-page-pause-applied-after-ms`). Only the two pause authority issuer routes are posted. Focus returns to the button, and the row shows "Pausada" with pause disabled ("A impressora não está imprimindo."). Then the Connector is revoked: the row turns read-only, pause stays disabled with a reason (`farm-page-pause-revoked-disabled-after-ms`), and the pause count stays 1. |
| `farm-page-revocation` | Same, then the Connector is revoked: read-only within 10 s. No signalling WebSocket is opened, and live status does not return, for 31 s: longer than the view's 30 s reopen backoff cap (`REOPEN_MAX_MS`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Adding rows

Rows live in `tests/helpers/rtc-farm-acceptance-scenarios.ts`. A row is the opt-in environment for the signalling harness plus the ledger lines that prove it passed. The runner, cluster and sealed build are shared, and each row still provisions fresh identities. Pause and camera rows add an entry there, plus any harness opt-in they need.

## Stale fixtures fixed while building the runner

- `tests/helpers/signalling-https-manifest.ts`: current Nitro output links deduplicated packages under `server/node_modules`. Internal relative links are now sealed by their target. Absolute and escaping links are still refused.
- `tests/helpers/signalling-runtime-moonraker.ts`: the Connector's complete observation also queries `extruder`/`heater_bed` temperatures (#74). The strict fixture rejected that query and the runtime never became ready.
- The layer build needs the app's generated tsconfig (`nuxt prepare`).
- The farm-page check used a 3 s disconnect bound and a 28 s overall budget (the RTC fixture child exited after 30 s). It now asserts the 10 s read-only requirement from #8 and adds the recovery and revocation-stop checks. The child's bounded lifetime is now 90 s, so the revocation window can exceed the reopen cap.
- The output seal also resolves link chains (`realpath`) and refuses links to the output root, not only lexically escaping links.

## Results

Dates are UTC.

On 2026-11-12, cortexos (Ubuntu amd64, Docker 29, Node 24.22.2) ran the full default command with `postgres:17@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`.

Runner head `acb30a2` (current rows):

| Row                    | Result | Read-only after | Recovered after (from drop) |
| ---------------------- | ------ | --------------- | --------------------------- |
| `farm-page-disconnect` | pass   | 10 ms           | 4.2 s, then new data        |
| `farm-page-revocation` | pass   | 2.4 s           | none within 31 s (expected) |

Earlier, three separate invocations at head `714ab51` (with the then-weaker rows) all passed. Recovery took 3.9 s each time.

After every invocation, no container with the run's label remained and the work directory had been removed. This is synthetic evidence for these rows and this artifact. It does not cover a real Moonraker/Klipper, a camera, pause, or a physical printer.

### `farm-page-pause` row (2026-11-12)

The full default command (all three rows) ran three times on cortexos at `032439e`, using the same image and the shared host:

| Invocation | `farm-page-disconnect`       | `farm-page-revocation` | `farm-page-pause` (read-only / recovered / confirm→applied) |
| ---------- | ---------------------------- | ---------------------- | ----------------------------------------------------------- |
| 1          | pass                         | pass                   | pass (17 ms / 6.3 s / 124 ms)                               |
| 2          | fail: harness source re-hash | pass                   | pass (16 ms / 7.3 s / 124 ms)                               |
| 3          | pass                         | pass                   | pass (18 ms / 4.2 s / 109 ms)                               |

Notes on the non-passing results:

- **Invocation 1** reported `failed` even though all three rows passed. The final `docker rm --force` of its own container took longer than the runner's 60 s Docker timeout under host load. The container was gone afterwards.
- **Invocation 2:** the `farm-page-disconnect` acceptance itself passed, but the harness's end-of-run source and artifact re-hash ("Cleanup incomplete: source and artifact manifest") failed. This happened in the existing row, unchanged here.
- **Earlier runs at older heads** also had failures:
  - Chromium reported `ERR_NETWORK_CHANGED` at login during one `farm-page-disconnect` run. Other jobs on the host were changing the network at the time.
  - Two `farm-page-pause` failures exposed defects that are now fixed:
    - The page judged freshness against a once-a-second clock tick, so a frame received after the tick looked stale and closed the dialog. It now uses a current clock sample.
    - The dialog was opened before the Connector had re-admitted its pause inbox after the drop. The row now waits for that.

Every pause run that reached the confirmation recorded exactly one `printer.print.pause` on the synthetic Moonraker, and none after revocation. No physical printer was contacted.
