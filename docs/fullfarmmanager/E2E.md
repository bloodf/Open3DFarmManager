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

These are source-level assertions. Their presence does not establish that they
passed on the current revision. The journey suite is opt-in and is not invoked
by `check:all` or the Checks workflow. The workflow's browser `e2e` job runs
only on `workflow_dispatch` and runs `test:e2e:auth-session` and `test:e2e`,
not `test:journey`.

## Earlier run and remaining acceptance

On 2026-11-23, the command above exited 0 in 2.2 minutes. The shell,
printer and resin, and spool finder journeys passed as they existed then.
Playwright skipped the collection and Integration API journeys, which were
marked `test.fixme` at that time. The run is not evidence for the later
assertions in those journeys.

Both journeys are enabled in the current source. The collection confirmation
fix (`b32b2e60`) and the Integration API history-link fix (`fa0f2bc8`)
removed their respective `test.fixme` markers. Run the journeys again on the
candidate under review before recording their results; the historical run does
not establish that either now passes.

The repository-owned acceptance work still needs a recorded journey run for
each completed phase, including the updated finder and resin assertions, and a
manual Checks workflow run on `main`. A workflow definition or a local run is
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

The remaining acceptance items in this repository are a new run of the five
journeys after these changes, the manual Checks workflow on `main`, and the
remaining simulator cases above. Current issue ownership is separate: #809 is
the active shared-design request; #663 is open for catalog and vendor-driver
work; #666 and its request issues #669, #670, and #675–#684 are closed. API
follow-up stays with its sibling orchestrator. Hardware qualification is
deferred to the owner under #255 and is not part of automated acceptance.
