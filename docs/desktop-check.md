# Desktop offline check (`npm run desktop:check`)

One command proves OpenFarm works inside the desktop limits: no network beyond
loopback, no Docker, system Chrome, a local PostgreSQL cluster and optional Go.

```sh
npm run desktop:check                       # every step
npm run desktop:check -- --list             # step names
npm run desktop:check -- --only lint,build  # a subset (reported as partial)
npm run desktop:check -- --skip test-e2e --receipt receipt.json
```

## Preflight

Prints the Node, npm, Chrome, PostgreSQL and Go versions it will use. It fails
when Node is outside `>=22.18 <25`, npm, Chrome or the PostgreSQL binaries
(`initdb`, `pg_ctl`, `postgres`, version 13 or newer) are missing, when
`OPENFARM_PG=docker`, `OPENFARM_SIM=docker`, `OPENFARM_BROWSER=bundled` or
`DOCKER_HOST` is set, or when `NUXT_BAMBU_CLOUD` is on. Go is optional: without
it `build-rtsp-ingest` is skipped and the summary says why. Chrome comes from
`OPENFARM_CHROME_PATH`, `/opt/google/chrome/chrome`, the macOS application, or
`google-chrome[-stable]` on `PATH`.

## Network guard

Every Node process a step starts runs `scripts/desktop-network-guard.mjs`
(`--import` through `NODE_OPTIONS`). It rejects `net`, `tls`, `dgram`, `http(s)`,
`fetch`, `WebSocket` and DNS calls whose destination is not loopback
(`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) or a Unix socket, and appends each
attempt to a log. A step with a logged attempt fails even when the child
swallowed the error, and the summary lists each attempt. Docker is hidden
from `PATH` in every step, so children see it as not installed.
Children also get `OPENFARM_TIMEOUT_SCALE=3` (Playwright test and expect timeouts, for slower desktops; assertions are unchanged), `npm_config_offline=true`, `GOPROXY=off`, `GOTOOLCHAIN=local`
and `PLAYWRIGHT_BROWSERS_PATH=/nonexistent`.

The guard covers Node. Chrome and Go are covered by their offline settings; on
Linux run the whole check in an empty network namespace for the rest:

```sh
sudo unshare --net -- bash -ec '
  ip link set lo up
  ip link add dummy0 type dummy && ip addr add 10.77.0.2/24 dev dummy0 && ip link set dummy0 up
  exec setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups \
    npm run desktop:check -- --require-isolated-network'
```

(`unshare -rn` also works, but PostgreSQL refuses to initialise as root, so use
a real user as above or an equivalent firewall.) `--require-isolated-network`
fails the run if any interface other than loopback and `dummy*` carries an address (the dummy interface goes nowhere; the LAN journeys need a private address on the host).
`--guard-probe` adds a step that makes a deliberate `fetch('https://example.com')`
and must fail the run.

## Steps

`preflight`, `lint`, `typecheck`, `vitest`, `test-node`, `rtsp-supervisor`,
`rtsp-framing`, `build`, `build-rtsp-ingest`, `test-postgres` (local cluster),
`test-e2e` (system Chrome), `test-journey` and `test-sim-farm` (loopback mocks),
and `app-smoke`: the built app and the real Connector on loopback mocks with
`/healthz`, `/readyz` and the farm page loaded in Chrome. Steps that need the
build are skipped when it fails. The summary lists every step with status,
duration and skip or failure reason; `--receipt` writes the same as JSON.

The manual `Desktop offline check` workflow runs it on Node 22 with Docker
removed from `PATH` and the network namespace unshared.
