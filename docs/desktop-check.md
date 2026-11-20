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

  Diagnosis from the retained logs and a focused local rerun
  (`harness-smoke.spec.ts`, local PostgreSQL 17, system Chrome): two separate
  defects.
  - The journey wired `NUXT_AUTH_DATABASE_URL` to a `farm_password_auth`
    login, but the auth connection role must be `farm_account_registration`
    (see [Account creation](ACCOUNT-CREATION.md)). The sign-in page swallows
    the failed `/api/auth/google` call, so sign-in still worked and the 42501
    was not what stopped telemetry. The journey now uses a
    `farm_account_registration` login (no superuser, `BYPASSRLS` or new
    grants), checks its grants at fixture start and requires
    `/api/auth/google` to answer `enabled: false` before a journey starts.
  - Every failure stops at the same assertion: the reported-progress bar was
    "not found". Commit `54f0b9cf` replaced the card's `<progress value>` and
    its "Progresso informado da impressão: N%" label with `ProgressRing`
    (`aria-label` without the colon, `aria-valuenow` in points). The journey
    locators now match that contract and assert the same fractions.

Issue #367 stays open until every step passes on one candidate. The
`test-sim-farm`, `app-smoke` and RTSP steps ran offline with no blocked attempt.

## Integrated Linux reproduction for #367 and #370

Candidate `66899d982ce3953050a6726c8cb7e50ce9cdbc94` was checked from clean
Git checkouts on Ubuntu 24.04.5 ARM64 with Node 22.23.5, npm 10.9.9, system
Chrome 158.0.8127.36, PostgreSQL 17.12 and Go 1.27.4. Docker was absent from
`PATH`. FFmpeg was disabled inside the acceptance namespace. The packaged
PostgreSQL services stayed off and the test runner owned its local clusters.

Stage the dependencies in an npm cache, enter an empty network namespace, and
bring up only `lo`. Run the commands as the checkout owner so that PostgreSQL
can initialize its disposable cluster. The ARM64 run reused a staged native
npm cache.

```sh
sudo unshare --net -- bash -ec '
  ip link set lo up
  exec setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups \
    env HOME="$1" PATH="$2" bash -s
' _ "$HOME" "$PATH" <<'OFFLINE'
set -eu
ip -br link
ip route
npm ci --offline --ignore-scripts --cache "$HOME/openfarm-npm-cache"
node --test tests/node/e16-367.test.mjs
npm run desktop:check -- --list
npm run desktop:check -- --require-isolated-network \
  --log-dir ./desktop-check-logs --receipt ./desktop-check-logs/receipt.json
OFFLINE
```

Make the PostgreSQL 17 binaries available on `PATH` before running the check.
The block above reproduces the loopback-only run. For a LAN journey
qualification, add the isolated dummy interface shown under Network guard
before dropping privileges. The focused Anycubic discovery case that failed
on loopback alone passed with `dummy0` and no default route (1.3 s for the
case, 40.2 s for Playwright). The focused Bambu browser journey and
Creality discovery case also passed with `dummy0` (2.1 min and 3.4 s,
respectively). The focused runs recorded zero non-loopback attempts. The
combined receipt still belongs to the original namespace.
The runner and guard contract gate passed 12 tests in 1.20 s. It does not run
Playwright. A separate `--guard-probe --only network-guard-probe` run in the
namespace exited 1 in 59 ms and recorded one blocked `fetch` to
`example.com`. Interface counters were unchanged, and only loopback existed
with no external route. A separate run with Go absent from `PATH` listed
`build-rtsp-ingest` as skipped in 0 ms and explained that Go 1.26 or later
was required. The Node suite passed 1,966 cases and skipped eight opt-in
cases. Two real-FFmpeg qualifications require
`OPENFARM_CAMERA_FFMPEG_QUALIFY=1`. The sandbox smoke requires
`OPENFARM_INTEGRATION_E2E=1`. The pause-control RTC case requires
`PAUSE_CONTROL_RTC=yes`. The two authenticated HTTPS/RTC cases require
`SIGNALLING_HTTPS_RTC_FIXTURE=yes` and parent-owned fixtures. The two external
GPL artifact cases require artifacts supplied by their parent.

### README desktop reproduction

On a separate clean ARM64 checkout inside an equivalent network namespace,
`npm ci --ignore-scripts` with npm offline mode and the staged native cache
passed in 9.69 s. The offline dependency report and `npm run build` passed.
The build took 27.38 s.

The documented `initdb` succeeded. The next command, `pg_ctl start`, failed
because the packaged PostgreSQL tried to create its socket lock in
`/var/run/postgresql` and received `Permission denied`. For diagnosis,
adding `-k $OPENFARM_DB_DIR` to the server options let the cluster start and
`createdb` pass. The documented database environment then left `npm run dev`
serving HTTP 500 for `/farm` with `invalid-config`. With
`NUXT_DATABASE_MIGRATIONS_DIR="$PWD/infra/db/migrations"` added, `/farm`
returned HTTP 200 in dev and in the compiled server. The disposable cluster
stopped with `pg_ctl stop`.

`npm run sim:verify` passed in 0.94 s, and
`npm run desktop:check -- --only app-smoke` passed in 5.74 s. The smoke
opened `/farm` in Chrome and recorded telemetry for both `sv06` and `u1`.
Its page assertions cover loading, rendered text and loopback requests.
They do not establish that the printer names appear in the page.
`npm run desktop:check -- --list` listed all 14 steps.

On a separate Ubuntu amd64 guest with Node 22.23.5 x64, the documented
`desktop:bundle` glibc staging pass succeeded. Its musl staging pass
failed during `nuxt prepare` while loading Rolldown. The error reported
missing `@rolldown/binding-wasm32-wasi` and the glibc native binding.
No archive was emitted, so archive extraction, archive-backed offline install
and the per-package fallbacks remain unverified. A separate glibc-native
cache did support `npm ci --offline --ignore-scripts` and `npm run build`
on a clean x64 checkout in a loopback-only namespace. The x64 install took
17.40 s and the build took 57.55 s. This cache run used no generated bundle.

### Combined gate result on ARM64

**BLOCKED.** The loopback-only run exited 1 after 36 min 27 s with
13 passed, one failed and zero skipped steps. The guard logged zero
non-loopback attempts. Every step had a duration in the console summary
and receipt.

| Step                | Status          | Duration (ms) |
| ------------------- | --------------- | ------------: |
| `preflight`         | passed          |            82 |
| `lint`              | passed          |        43,567 |
| `typecheck`         | passed          |        43,692 |
| `vitest`            | passed          |       239,680 |
| `test-node`         | passed          |       326,468 |
| `rtsp-supervisor`   | passed          |         2,983 |
| `rtsp-framing`      | passed          |           197 |
| `build`             | passed          |        18,301 |
| `build-rtsp-ingest` | passed          |         1,760 |
| `test-postgres`     | passed          |       194,802 |
| `test-e2e`          | passed          |        26,920 |
| `test-journey`      | failed (exit 1) |     1,275,916 |
| `test-sim-farm`     | passed          |         7,161 |
| `app-smoke`         | passed          |         5,788 |

Playwright E2E passed 67 cases and skipped 27. The skipped cases were the
23 authentication lockout and session cases, one browser device case,
two pairing cases and one printer assignment case. Their configurations
require explicitly provisioned disposable HTTPS and PostgreSQL fixtures,
including the separate remaining-cases pairing phase.

The journey suite passed the KobraLink bridge discovery case and failed the
following 11 cases. Its serial groups left 25 later cases unrun.

| Case                                                          | Failure                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| `anycubic.spec.ts:443:5`, discovery and assignment            | `Não foi possível procurar impressoras. Tente novamente.` |
| `bambu.spec.ts:295:5`, browser journey                        | `#kobra-prepared-heading` absent after 60 s               |
| `creality.spec.ts:251:5`, discovery and farm listing          | `Não foi possível procurar impressoras. Tente novamente.` |
| `harness-smoke.spec.ts:32:5`, Moonraker fixture telemetry     | `Conexão direta autenticada` absent after 60 s            |
| `harness-vendors.spec.ts:70:7`, Bambu simulator telemetry     | `Conexão direta autenticada` absent after 60 s            |
| `harness-vendors.spec.ts:70:7`, Creality simulator telemetry  | `Conexão direta autenticada` absent after 60 s            |
| `harness-vendors.spec.ts:70:7`, Anycubic simulator telemetry  | `Conexão direta autenticada` absent after 60 s            |
| `harness-vendors.spec.ts:70:7`, KobraLink simulator telemetry | `Conexão direta autenticada` absent after 60 s            |
| `kobra-x-native.spec.ts:33:5`, native setup and confirmation  | `#kobra-prepared-heading` absent after 60 s               |
| `kobralink.spec.ts:204:5`, bridge telemetry on the farm page  | `Conexão direta autenticada` absent after 60 s            |
| `moonraker.spec.ts:37:5`, journey and job completion          | `Conexão direta autenticada` absent after 60 s            |

The three focused `dummy0` cases provide evidence for that topology. The
remaining eight failed cases have no result on `dummy0`. Both issues remain
open pending a fresh combined run on the integrated candidate and the
README acceptance.

## Integrated candidate with an isolated LAN interface

Candidate `10cb8318623f9cea64bae41a09b1a286eae464e9` incorporates the
bundle staging fix. The ARM64 combined run used Ubuntu 24.04.5, Node
22.23.5, npm 10.9.9, system Chrome 158.0.8127.36, local PostgreSQL 17.12
and Go 1.27.4. Docker was absent from `PATH`, and FFmpeg was disabled in
the combined run. The namespace had loopback and the documented
`dummy0` address. IPv4 and IPv6 had no default route; the simulated
services listened on loopback.

The standalone guard probe exited 1 in 41 ms and recorded one blocked
attempt. The dummy interface's transmit counters did not change during the
probe. The focused runner
and guard contract passed all 12 cases. The Node suite passed 1,967 cases
and skipped the same eight opt-in cases described in the loopback-only
receipt. Playwright E2E and the separate PostgreSQL gate both passed.

### README and bundle verification

On a separate clean ARM64 checkout, the corrected guide's complete sequence
used the staged native npm cache. Install took 7.62 s and build took
24.48 s. The documented PostgreSQL commands passed after ordering
`initdb` before creation of the socket directory and giving Nuxt the
migration directory. The dev server and built server both returned HTTP 200
for `/farm`. The simulator check and Chrome app-smoke passed. The focused
Moonraker journey passed in 45.5 s and verified the printer card and
reported progress in the browser. The guard logged zero attempts. The
README contract suite passed all 13 cases with the revised guide.

On Ubuntu amd64 with Node 22.23.5 x64, the documented direct bundle command
staged both glibc and musl and emitted a 605-entry archive in 65.66 s.
After extraction into an empty cache, an isolated clean glibc checkout
installed from the archive in 26.21 s and built in 90.58 s. This verifies
the archive-backed install on the declared x64 target. The musl runtime
and individual native-package replacement recipes were outside this run.

The amd64 guest also passed PostgreSQL setup, dev and compiled `/farm`
HTTP checks, the simulator check and app-smoke using Chrome 158.0.8127.36.
The focused visible-printer journey failed twice in that guest at
`tests/helpers/kobralink-rtc/acceptance.ts:49`. The browser waited 10 s
for Vue to mount on `/entrar` and timed out before the farm assertion.
The guarded diagnostic rerun recorded zero attempted outbound connections.
The successful ARM64 browser run and the successful amd64 archive install
each apply to their respective targets.

### Combined result on the documented topology

**BLOCKED.** The combined run took 35 min 5 s, with 13 steps passed,
one failed and zero skipped. The guard logged zero attempts. E2E
passed 67 cases and skipped the same 27 fixture-dependent cases as
the loopback-only run. PostgreSQL passed all 34 jobs.

| Step                | Status          | Duration (ms) |
| ------------------- | --------------- | ------------: |
| `preflight`         | passed          |           148 |
| `lint`              | passed          |        45,635 |
| `typecheck`         | passed          |        42,112 |
| `vitest`            | passed          |       281,447 |
| `test-node`         | passed          |       398,582 |
| `rtsp-supervisor`   | passed          |         2,967 |
| `rtsp-framing`      | passed          |           226 |
| `build`             | passed          |        21,230 |
| `build-rtsp-ingest` | passed          |         1,998 |
| `test-postgres`     | passed          |       177,837 |
| `test-e2e`          | passed          |        25,224 |
| `test-journey`      | failed (exit 1) |     1,087,641 |
| `test-sim-farm`     | passed          |         7,419 |
| `app-smoke`         | passed          |        12,972 |

The journey suite passed 36 of 37 cases. The sole failure was
`tests/journey/kobralink.spec.ts:390:5`, “the finished job shows its end card
and history entry.” At line 411 the unnamed progressbar locator expected
zero elements and still found one after 15 s. The card's reported-progress
ring and the status-wall progressbar share that role. The focused fix uses
the existing `reportedProgress` locator and keeps the zero-count assertion
for the reported ring alongside all end-card and history assertions.

The first focused rerun reached the history assertions and failed at line 428. Both history rows include a sixth cell for library provenance. The
test now asserts `Fora da biblioteca` for the bridge-uploaded and
cancelled jobs, along with the existing printer, outcome, filename,
timestamp and duration checks.

The second focused rerun verified both six-cell rows and reached the
empty-filter assertion. The page rendered the heading
`Nenhum trabalho finalizado`; the old assertion looked for
`Nenhum trabalho finalizado registrado.`. That run also logged
`Runtime fixture cleanup/failure` with a Connector exit by `SIGKILL`.
These findings belong to the separate KobraLink correction. This report
does not change the journey test or replace the combined receipt.
