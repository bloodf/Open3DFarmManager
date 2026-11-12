# Real-RTC farm-page acceptance checkpoint

Issues #8 and #9. `pnpm run test:rtc-farm` (`scripts/test-rtc-farm-acceptance.ts`) runs the real-RTC farm-page acceptance in one command. Before this runner existed, the same scenario (`scripts/test-signalling-https.ts` with `SIGNALLING_HTTPS_FARM_PAGE=yes`) needed a hand-built disposable PostgreSQL, a sealed build layer, a CA and a private ledger, and none of that was documented. This runner is the base of the combined Phase 0 acceptance; pause and camera rows plug into it (see [Adding rows](#adding-rows)).

## What runs

- A fresh, disposable, digest-pinned PostgreSQL 17 container: read-only root, tmpfs data, all capabilities dropped, `--pull never`, a fixed loopback port. It is migrated to the current catalog. The runner never accepts a database URL or an existing container. It removes only its own container, verified by ID and label.
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

SIGINT and SIGTERM stop the current process group; the container and work directory are still removed in `finally`.

## Rows

| Row                    | Flow                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farm-page-disconnect` | Login → paired Connector → farm view shows "Conexão direta autenticada" and live progress over WebRTC (0.25 → 0.75). Then the signalling connections drop: the row turns read-only within 10 s, keeps the last observation and the pause button stays disabled. Recovery (#121): the view re-checks authority and reopens while the Connector reconnects, and live status returns. |
| `farm-page-revocation` | Same, then the Connector is revoked: read-only within 10 s, and live status does not return for at least 5 s afterwards (no reopen).                                                                                                                                                                                                                                               |

## Adding rows

Rows live in `tests/helpers/rtc-farm-acceptance-scenarios.ts`. A row is the opt-in environment for the signalling harness plus the ledger lines that prove it passed. The runner, cluster and sealed build are shared, and each row still provisions fresh identities. Pause and camera rows add an entry there, plus any harness opt-in they need.

## Stale fixtures fixed while building the runner

- `tests/helpers/signalling-https-manifest.ts`: current Nitro output links deduplicated packages under `server/node_modules`. Internal relative links are now sealed by their target. Absolute and escaping links are still refused.
- `tests/helpers/signalling-runtime-moonraker.ts`: the Connector's complete observation also queries `extruder`/`heater_bed` temperatures (#74). The strict fixture rejected that query and the runtime never became ready.
- The layer build needs the app's generated tsconfig (`nuxt prepare`).
- The farm-page check used a 3 s disconnect bound and a 28 s overall budget. It now asserts the 10 s read-only requirement from #8 and adds the recovery and revocation-stop checks.

## Results

On 2026-11-12, cortexos (Ubuntu amd64, Docker 29, Node 24.22.2) ran the full default command three times. Each invocation used a fresh cluster and sealed build at head `714ab51`, with `postgres:17@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`. The doc and script-entry commits after `714ab51` change no runner or fixture code.

| Invocation | `farm-page-disconnect` | Recovery after loss | `farm-page-revocation` |
| ---------- | ---------------------- | ------------------- | ---------------------- |
| 1          | pass, 22.0 s           | 3.9 s               | pass, 27.8 s           |
| 2          | pass, 23.9 s           | 3.9 s               | pass, 25.7 s           |
| 3          | pass, 22.5 s           | 3.9 s               | pass, 26.6 s           |

After each invocation, no container with the run's label remained, and the work directory had been removed. This is synthetic evidence for these rows and this artifact. It does not cover a real Moonraker/Klipper, a camera, pause, or a physical printer.
