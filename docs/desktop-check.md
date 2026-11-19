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

## Local Linux reproduction

Tested on candidate `c08c1fa8c4b2d2d14b45bdfe15d29f44dc7944c4` in a disposable
Ubuntu 24.04 ARM64 virtual machine (9 CPUs, 15 GB) with Node 22.23.5, npm 10.9.9,
Chrome 158.0.8127.36 installed at `/opt/google/chrome/chrome`, PostgreSQL 17.12
(PGDG packages) and Go 1.27.4. Nothing in the machine used Docker. The virtual
machine was created for this run and is the only resource it owns; delete it
when the run is accepted.

Stage everything while the network is still up, then run offline:

1. Install the system packages: the libraries Chrome links against,
   `iproute2`, `util-linux`, PostgreSQL 13 or newer (`initdb`, `pg_ctl` and
   `postgres` come with the server package; disable the packaged service, the
   tests start their own cluster) and `ffmpeg`. `ffmpeg` is not a prerequisite
   of the default desktop run, but it is installed on the reproduction machine
   so that its FFmpeg-dependent camera tests do not skip.
2. Install Node 22, Chrome (`/opt/google/chrome/chrome`) and, for the optional
   `build-rtsp-ingest` step, Go. Go builds with `GOPROXY=off`, so warm its
   module cache first with `go mod download` in `tools/rtsp-ingest`.
3. Check out the candidate as a real git checkout. Several tests run
   `git status`, so an exported tree without `.git` fails them.
4. Warm the npm cache and remove `node_modules`. `npm run desktop:bundle`
   builds the documented bundle for `linux-x64` only; on an ARM64 machine it
   stops in `nuxt prepare`, so the reproduction used a native cache instead:
   `npm ci --ignore-scripts --cache "$HOME/openfarm-npm-cache"`, then
   `rm -rf node_modules apps/*/node_modules packages/*/node_modules`. On an
   x64 machine, unpack the bundle as described in
   [desktop-offline-install.md](desktop-offline-install.md).
5. Inside the isolated namespace, install from the cache with
   `npm ci --offline --ignore-scripts --cache "$HOME/openfarm-npm-cache"`, run
   the focused gate, then the check:

```sh
sudo HOME="$HOME" unshare --net -- bash -ec '
  ip link set lo up
  ip link add dummy0 type dummy && ip addr add 10.77.0.2/24 dev dummy0 && ip link set dummy0 up
  exec setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups \
    env HOME="$HOME" bash -ec "
      npm ci --offline --ignore-scripts --cache \"\$HOME/openfarm-npm-cache\"
      node --test tests/node/e16-367.test.mjs
      npm run desktop:check -- --list
      npm run desktop:check -- --require-isolated-network \
        --log-dir ./desktop-check-logs --receipt ./desktop-check-logs/receipt.json"'
```

Pass `HOME` through `sudo` explicitly: on Ubuntu `sudo` resets it to `/root`,
which makes npm, the PostgreSQL runner and the log directory fail with
permission errors. Inside the namespace `curl https://example.com` fails and
`ping` reports the network is unreachable, which confirms the isolation. The
focused gate passes 12 of 12 in under a second and, by design, does not run
Playwright. Offline `npm ci` installed 628 packages in 5.4 seconds, and
`desktop:check -- --list` printed the 14 steps.

### Result (not accepted)

`desktop:check` reported 11 passed, 3 failed and 0 skipped in 25 min 52 s. The
network guard logged no attempt and the receipt lists no external interface.

| Step                                                    | Result | Duration              |
| ------------------------------------------------------- | ------ | --------------------- |
| preflight, lint, typecheck                              | passed | 0.1, 28.1, 28.1 s     |
| vitest                                                  | passed | 3 min 0 s             |
| test-node                                               | passed | 4 min 41 s            |
| rtsp-supervisor, rtsp-framing, build, build-rtsp-ingest | passed | 3.0, 0.2, 18.0, 5.7 s |
| test-postgres                                           | failed | 2 min 18 s            |
| test-e2e                                                | failed | 57.2 s                |
| test-journey                                            | failed | 13 min 24 s           |
| test-sim-farm, app-smoke                                | passed | 3.8, 4.3 s            |

Failures on this candidate:

- **test-postgres** (31 of 33 jobs pass):
  - `test-postgres-connector-inventory.ts` fails to load
    `apps/farm/server/storage/sign-in-provider.ts`, whose constructor uses
    TypeScript parameter properties (`private readonly master`,
    `private readonly issuer`) that Node's type stripping does not accept
    (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
  - `test-postgres-registration.ts` fails in `link_oidc_identity` with
    `invalid regular expression: invalid repetition count(s)`.
    `infra/db/migrations/0077_oidc_identity_management.up.sql` repeats
    `{1,500}`, above the 255 PostgreSQL allows; migration 0075 fixed the same
    pattern in the table check but not in this function.
- **test-e2e** (64 passed, 27 skipped, 3 failed):
  `farm-view.spec.ts:280` "populated spool table is accessible and fits at
  320px" and "at 1280px" (the table shows 3 of 12 spools and never contains
  `-12 g`), and `frontend-accessibility.spec.ts:14` "home keyboard navigation
  exposes account routes and unavailable read-only state" (the "Convidar
  pessoa" quick link does not take focus on the expected Tab stop).
- **test-journey** (4 passed, 10 failed, 23 did not run): the Anycubic, Bambu
  Lab, Creality, KobraLink and Moonraker journeys and the four vendor harness
  smoke cases (`harness-smoke`, `harness-vendors`) never see live telemetry.
  The farm server logged `permission denied for table sign_in_providers` (SQL
  state `42501`) from `/api/auth/google`; migration `0076_sign_in_providers`
  grants the table only to `farm_account_registration`.

Issue #367 stays open until every step passes on one candidate. The
`test-sim-farm`, `app-smoke` and RTSP steps ran offline with no blocked attempt.
