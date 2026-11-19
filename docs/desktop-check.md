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

Tested on candidate `0750dc36c09ad140c177b4425d587976a39aa8e2` in a disposable
Ubuntu 24.04 ARM64 virtual machine (9 CPUs, 15 GB) with Node 22.23.5, npm 10.9.9,
Chrome 158.0.8127.36 installed at `/opt/google/chrome/chrome`, PostgreSQL 17.12
and Go 1.27.4. Nothing in the machine used Docker.

Stage everything while the network is still up, then run offline:

1. Install the system packages: the libraries Chrome links against, `ffmpeg`
   (the camera tests in `test:node` and the journeys call `which ffmpeg` and
   fail without it), `iproute2`, `util-linux` and PostgreSQL 13 or newer
   (`initdb`, `pg_ctl` and `postgres` come with the server package; disable the
   packaged service, the tests start their own cluster).
2. Install Node 22, Chrome (`/opt/google/chrome/chrome`) and, for the optional
   `build-rtsp-ingest` step, Go. Go builds with `GOPROXY=off`, so warm its
   module cache first with `go mod download` in `tools/rtsp-ingest`.
3. Check out the candidate as a real git checkout. Several tests run
   `git status`, so an exported tree without `.git` fails them.
4. `npm ci` in the checkout.
5. Run the focused gate, then the isolated check with the command in
   [Network guard](#network-guard):

```sh
node --test tests/node/e16-367.test.mjs
sudo unshare --net -- bash -ec '
  ip link set lo up
  ip link add dummy0 type dummy && ip addr add 10.77.0.2/24 dev dummy0 && ip link set dummy0 up
  exec setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups \
    env HOME="$HOME" npm run desktop:check -- --require-isolated-network \
      --log-dir ./desktop-check-logs --receipt ./desktop-check-logs/receipt.json'
```

Inside that namespace `curl https://example.com` fails to resolve and `ping`
reports the network is unreachable, which confirms the isolation. The focused
gate passes 12 of 12 in about 1.6 seconds and, by design, does not run
Playwright.

### Result (not accepted)

`desktop:check` reported 9 passed, 5 failed and 0 skipped in 38 min 26 s.

| Step                                                    | Result | Duration              |
| ------------------------------------------------------- | ------ | --------------------- |
| preflight, lint, typecheck                              | passed | 0.1, 38, 48 s         |
| vitest                                                  | failed | 3 min 0 s             |
| test-node                                               | failed | 5 min 5 s             |
| rtsp-supervisor, rtsp-framing, build, build-rtsp-ingest | passed | 3.2, 0.2, 17.9, 0.3 s |
| test-postgres                                           | failed | 2 min 26 s            |
| test-e2e                                                | failed | 6 min 27 s            |
| test-journey                                            | failed | 19 min 31 s           |
| test-sim-farm, app-smoke                                | passed | 4.1, 5.1 s            |

Failures on this candidate, none of them an environment gap once `ffmpeg` and
the git checkout were in place:

- **vitest** (2600 of 2601 tests pass): `tests/unit/network-map.test.ts`, "passes
  axe, fits and is keyboard reachable at 320, 768 and 1280 px with 2 Connectors".
  The first Tab stops do not start with the `Mapa` view button. It fails alone too.
- **test-node** (1966 pass, 0 fail, 6 skipped): every test passes, but the guard
  recorded two `https.request` attempts to `farm.example` from
  `tests/node/connector-credential-renewal.test.ts` (through
  `packages/connector/src/runtime/library-relay.ts`), so the step fails.
- **test-postgres** (31 of 33 jobs pass): `test-postgres-connector-inventory.ts`
  and `test-postgres-registration.ts` fail to load
  `apps/farm/server/storage/sign-in-rules.ts`, whose `constructor(private readonly
sql: Sql)` is a TypeScript parameter property that Node's type stripping does
  not accept.
- **test-e2e** (52 passed, 27 skipped, 15 failed): `connector-inventory`,
  `farm-view` camera region, `files-page` (esbuild has no loader for `.vue`),
  three `frontend-accessibility` cases, two `kobra-x-controls` cases, four
  `printer-setup-forms` cases and two `skeleton` cases. Several are strict-mode
  violations because a link such as "Início" or "Minha farm" now matches more
  than one landmark.
- **test-journey** (31 passed, 3 failed): the Anycubic pause/resume/cancel
  journey, the Bambu Lab journey and the KobraLink "finished job" journey. The
  Anycubic and Bambu Lab journeys passed in an earlier run on the same
  candidate (that run lacked `ffmpeg`, which failed four other journeys), so
  those two are timing dependent.

Issue #367 stays open until every step passes on one candidate. The
`test-sim-farm`, `app-smoke` and RTSP steps ran offline with no blocked attempt.
