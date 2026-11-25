# FullFarmManager end-to-end journeys

The five journeys in `tests/journey/fullfarmmanager-*.spec.ts` use a loopback
farm, disposable local PostgreSQL, the packaged Connector, and Moonraker or
Spoolman simulators.

Set up the local Chromium environment and temporary directory before running the suite.

```sh
OPENFARM_JOURNEY=1 npx playwright test -c playwright.journey.config.ts tests/journey/fullfarmmanager
```

## Coverage

- Shell keyboard search, persisted theme, and mobile navigation at 390 × 844.
- Live Moonraker inspection and manual resin vat, volume, film and LCD entries,
  with the recorded values shown again after reload.
- Spoolman import, combined material, color and location filters, a nonmatching
  color, one label-based relocation request, and the new location after reload.
- Farm floor and printer inspector, with a simulated print completion,
  refusal of the next start, operator confirmation, and a subsequent start.
- Sandbox Integration API submission with `printers:read`, `jobs:start`,
  `plates:confirm`, and `jobs:read` for history. The journey covers eligibility
  before and after initial clearance, approval, completion, plate
  acknowledgement replay, and history linkage to the submitted `jobId`.

These are source-level assertions. The local acceptance run below establishes
results for its exact tested candidate, not for every subsequent revision. The
journey suite is opt-in and is not invoked by `check:all` or the Checks workflow. The workflow's browser `e2e` job runs
only on `workflow_dispatch` and runs `test:e2e:auth-session` and `test:e2e`,
not `test:journey`.

## Local acceptance for #667

On 2026-11-24, the exact composed candidate `9cb88b5c`, based on
`cffa6cafb79b` with the collection fixture conflict reconciled, ran
`npm run test:journey -- tests/journey/fullfarmmanager` through Google Chrome,
disposable PostgreSQL, and loopback simulators. All five journeys passed:
collection hold and release, Integration API work and plate confirmation,
printer and resin, responsive shell, and spool finder.

The collection journey holds Start disabled and verifies that no extra
simulated start occurs. It then confirms collection and uses a fresh synthetic
standby observation for the next start. The separate nine-case Connector hold
suite also passed, including refusal and verification that the driver was not
invoked again. An earlier browser launch failure occurred before test execution.
Earlier baseline file-listing failures and a post-clearance stale advertisement
are historical context; the production refresh is tracked in #818.

## Earlier runs and remaining acceptance

The resin-only regate passed on `06c3def2`, the cherry-pick of `afcea4d6`
onto integrated head `0a617cdf`, which includes `ea86fb60`. The command
`npm run test:journey -- tests/journey/fullfarmmanager-printer.spec.ts`
exited 0 with one passing test using disposable local PostgreSQL and a
loopback Moonraker simulator. The journey checked the four initial unknown
values and verified the manual entries for vat (Cuba A), volume (250 mL),
film (125 layers), and LCD (12 hours), including after reload. Only the resin
journey ran in this regate. It predates the local acceptance run above.

On 2026-11-24, an independent local run of the unchanged `3d1a3f22`
baseline timed out waiting for the seeded file radio in the collection
journey. That baseline result is separate from the later acceptance changes.
On integrated head `0d83b5b7` (which includes `ea86fb60`), a local run with
the journey fixture corrections passed the printer and resin journey: all four
initial unknown values, the four manual entries and their values after reload
were exercised. The collection journey still failed: its file-list operation
reported a direct-connection error before the seeded radio appeared. The test
retains the radio selection and the collection-hold, refusal and release
assertions; those later assertions were not reached. This result does not
establish the cause of the file-list failure or a passing collection journey.
The integrated-head runs used disposable local PostgreSQL and a loopback
simulator, not a physical printer. The other three journeys were not rerun in
this correction.

On 2026-11-23, the command above exited 0 in 2.2 minutes. The shell,
printer and resin, and spool finder journeys passed as they existed then.
Playwright skipped the collection and Integration API journeys, which were
marked `test.fixme` at that time. The run is not evidence for the later
assertions in those journeys.

Both journeys are enabled in the current source. The collection confirmation
fix (`b32b2e60`) and the Integration API history-link fix (`fa0f2bc8`)
removed their respective `test.fixme` markers. The historical run does not
establish that either passed; the later candidate run is recorded above.

The repository-owned acceptance work still needs a fresh manual Checks
workflow run on `main`. A workflow definition or a local run is
not evidence that the manual workflow ran. The final summary on #668 remains
pending those results and the other phases. No physical printer is used in
these journeys; hardware qualification remains deferred to #255.

The backlog in [REVIEW.md](REVIEW.md#backlog) also calls for repeated and
out-of-order filament completion, queue hold through duplicate reports and a
restart, and dispatch failure boundaries. Unit coverage in
`tests/unit/filament-run-accounting.test.ts`,
`tests/unit/filament-run-tracker.test.ts`,
`tests/unit/queue-collection-state.test.ts`, and
`tests/unit/dispatch-run-correlation.test.ts` covers parts of these boundaries;
the collection browser journey does not itself exercise duplicate completion
reports or restart. A recorded resin run and reported readings remain separate
from the manual entries exercised here. Shared design (#809), Integration API,
and vendor-driver work are owned by sibling workstreams.

The remaining acceptance items in this repository include the fresh manual
Checks workflow on `main` and the remaining simulator cases above. Current
issue ownership is separate: #809 is the active shared-design request; #663 is open for catalog and vendor-driver
work; #666 and its request issues #669, #670, and #675–#684 are closed. API
follow-up stays with its sibling orchestrator. Hardware qualification is
deferred to the owner under #255 and is not part of automated acceptance.
