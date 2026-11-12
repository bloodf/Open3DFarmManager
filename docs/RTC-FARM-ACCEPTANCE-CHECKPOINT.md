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

| Variable                           | Meaning                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `RTC_FARM_TEST_IMAGE`              | Digest-pinned PostgreSQL 17 image, already present locally (never pulled).                                    |
| `RTC_FARM_TEST_DB_PORT`            | Loopback port for the container. The server, proxy and Moonraker use OS-assigned loopback ports.              |
| `RTC_FARM_TEST_WORK_ROOT`          | Private parent directory. Each run creates `<root>/<id>` (`0700`) and removes exactly that path in `finally`. |
| `RTC_FARM_TEST_SCENARIOS`          | Optional comma list of rows. Default: every row.                                                              |
| `RTC_FARM_TEST_REPEAT`             | Optional repeat count (1–5) of the selected rows against one cluster and build.                               |
| `RTC_FARM_TEST_NAME_PREFIX`        | Optional container name prefix (default `o3dfm-rtc-farm`).                                                    |
| `RTC_FARM_TEST_RTSP_HELPER`        | Camera rows only: absolute path of a prebuilt `rtsp-ingest` (see below).                                      |
| `RTC_FARM_TEST_RTSP_HELPER_SHA256` | Camera rows only: expected SHA-256 of that helper. It is checked before and after the private copy.           |
| `RTC_FARM_TEST_RTSP_PORT`          | Camera rows only: loopback port for the task-owned RTSP simulator.                                            |

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

| Row                    | Flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farm-page-disconnect` | Login → paired Connector → farm view shows "Conexão direta autenticada" and live progress over WebRTC (0.25 → 0.75). Then the signalling connections drop: the row turns read-only within 10 s (`farm-page-readonly-after-ms`), keeps the last observation, and the pause button stays disabled. Recovery (#121): the view re-checks authority and reopens while the Connector reconnects. Live status returns (`farm-page-recovered-after-ms`, measured from the drop), and a new fixture observation (0.9) reaches the page.          |
| `farm-page-revocation` | Same, then the Connector is revoked: read-only within 10 s. No signalling WebSocket is opened, and live status does not return, for 31 s: longer than the view's 30 s reopen backoff cap (`REOPEN_MAX_MS`).                                                                                                                                                                                                                                                                                                                             |
| `farm-page-camera`     | Same as revocation, plus camera video for the authorized assignment. The region shows "Câmera ao vivo." and the decoder makes progress (`currentTime` and `getVideoPlaybackQuality().totalVideoFrames` both advance over 1.5 s), with the ingest helper process running. "Parar imagem ao vivo" detaches the stream ("Imagem ao vivo parada."), and "Mostrar imagem ao vivo" plays it again with advancing frames. After revocation, no `<video>` in the page holds a stream, "Câmera ao vivo." is gone, and no helper process remains. |

### Camera row

`farm-page-camera` needs the ingest helper, built offline from the vendored sources as in [CAMERA-END-TO-END-CHECKPOINT.md](CAMERA-END-TO-END-CHECKPOINT.md#reproducing-the-interop-run). It can be cross-compiled with `GOOS=linux GOARCH=amd64` and copied to the runner host.

The runner then:

- verifies the helper's SHA-256, copies it into the work directory (`0700`) and verifies the copy;
- starts only the `rtsp` service of `infra/sim/docker-compose.yml` under the exact compose project `<container name>-rtsp`. A generated override maps `127.0.0.1:<RTC_FARM_TEST_RTSP_PORT>` to `8554`, the image must already be present (`--pull never`), and an RTSP `DESCRIBE` of `/test` must succeed before the row starts;
- passes the row a camera section for the Connector runtime: loopback literal address, that port, `/test`, the helper copy and its hash, for the single fixture assignment.

`docker compose down` removes that project in `finally`, and the runner checks that no container with the project label remains. A second signal also removes it.

Credential renewal while the page stays live is not a row yet. The signalling harness does not enable the renewal runtime or a renewal-capable Connector configuration, so it would need a new harness opt-in rather than a registry entry.

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
