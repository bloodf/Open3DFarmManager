# Running CI locally

Run the checks before publishing changes. These commands do not publish, cancel
or replace GitHub jobs. Branch protections and required remote checks remain in
force. Coordinate with other work in this checkout before running a build or
using simulator ports.

```sh
bash scripts/test-local-ci.sh
bash scripts/local-ci.sh code
```

The code job requires pnpm 12.18.0, Node 24.22.2, existing workspace dependencies,
Chromium and its operating-system libraries. Install browser prerequisites
separately; this runner never installs operating-system packages. Like
`.github/workflows/ci.yml`, it uses a frozen dependency install with scripts
disabled, runs `check:all`, checks the built Connector version and runs
Playwright. The local runner also runs `lint` before `check:all`, which runs
lint again. The workflow runs lint only through `check:all` and additionally
runs Playwright's `install --with-deps` on Ubuntu. Local browser, operating
system and resource scheduling may differ from GitHub. Missing prerequisites
or failed tests do not produce a passing result.

`check:all` covers lint, typechecking, the root unit and Node test suites,
and the build. Other browser or E2E experiments are separate from these checks
and may be deferred; this does not waive any required hosted checks.

The code job leaves two paths out. The default Playwright run skips
`tests/e2e/farm-view.spec.ts`, because the file calls `test.skip` unless
`FARM_VIEW_E2E` is `true`, and the default configuration keeps the farm view
flag off. The dedicated configuration `playwright.farm-view.config.ts` refuses
to load without that variable, turns the flag on and serves the app on port 3101 (override with `FARM_VIEW_PORT`; the default suite's
port 3100 is overridable with `E2E_PORT`; both accept an integer from 1 to 65535).
Build the app first, then run these cases on their own:

```sh
FARM_VIEW_E2E=true pnpm exec playwright test --config playwright.farm-view.config.ts
```

`packages/webrtc-experiment` has its own typecheck and test scripts, and neither
`check:all` nor the workflow runs them. Run the package scripts yourself:

```sh
pnpm --dir packages/webrtc-experiment run typecheck
pnpm --dir packages/webrtc-experiment run test
```

The transport and interop cases launch Playwright's Chromium. Neither path is a
GitHub check, so a passing code job says nothing about them.

Optional container jobs require explicit opt-in:

```sh
bash scripts/local-ci.sh image --containers
bash scripts/local-ci.sh klipper --containers --simulator
bash scripts/local-ci.sh all --containers --simulator
```

The image job builds the workflow Dockerfile for `linux/amd64`, starts a
read-only, capability-dropped container on a dynamically allocated loopback
port, and checks `/healthz`. Install the `linux/amd64` base images
`node:24.22.2-alpine` separately first; the runner refuses to
pull shared build bases implicitly. The GitHub job builds on Ubuntu amd64 and
uses port 3100. The dynamic port avoids disturbing other local services.

The Klipper job uses the existing Compose profile, the pinned amd64 image and
`sim:smoke` with its unchanged 90-second deadline. The smoke test checks only
SV06 readiness; it does not establish two-printer, four-tool or camera
acceptance. The runner refuses a detected running virtual-klipper instance and
uses a unique Compose project. Ports 7125, 7126, 8110 and 8111 are still fixed;
a collision fails rather than reusing another task's instance. It never sends
commands to physical printers. Image and simulator jobs require a reachable
Docker daemon and at least 10 GiB free on the checkout filesystem; check Docker
VM storage separately before pulling or building.

On a non-amd64 Docker host, image and Klipper jobs stop with `UNSUPPORTED`
unless `--allow-emulation` is supplied. An emulated amd64 run is useful
additional evidence, not equivalent to GitHub's native Ubuntu amd64 runner.
The separate native ARM64 simulator experiments are also not this workflow's
pinned amd64 job. Klipper readiness has failed intermittently on both local
and native environments; a failure stays a failure and cannot be skipped in
`all`. `all` runs code, image and Klipper sequentially and stops on failure.

Each invocation prints a private temporary ledger path outside the repository.
It records disk, Git status, worktrees, baseline shared outputs and, for
container jobs, Docker inventories and storage before and after. Container
names, project and image tags are unique to the invocation. It removes its own
container and Compose resources, including its fresh volumes, and removes the
simulator image only when it was absent at baseline and no container references
it. It keeps bounded failure logs. Docker's shared build cache, pre-existing
images, dependencies and shared build outputs remain: they may be needed by
other tasks and cannot safely be attributed from a single run. Review the ledger
and coordinate before removing any generated outputs or caches. No broad prune
is run. The local runner is a preflight, not proof of GitHub Actions parity.
