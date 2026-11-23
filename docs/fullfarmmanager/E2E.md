# FullFarmManager end-to-end journeys

The journeys in `tests/journey/fullfarmmanager-*.spec.ts` use the existing
loopback farm, disposable PostgreSQL, and simulator harness. They do not connect
to physical printers.

Run with:

```sh
OPENFARM_JOURNEY=1 npx playwright test -c playwright.journey.config.ts tests/journey/fullfarmmanager
```

## Coverage

- Shell palette keyboard access, persisted theme, and mobile navigation at
  390 × 844.
- Printer inspection and resin ledger entry on the simulated Moonraker printer.
- Spool import and label-location journey through the finder page.

## Run result

Command run on 2026-11-23:

```sh
source "$HOME/.local/state/openfarm-farm/chrome/env.sh" && OPENFARM_JOURNEY=1 npx playwright test -c playwright.journey.config.ts tests/journey/fullfarmmanager
```

Result: **3 failed, 0 passed**, 3m 44s. The printer journey timed out waiting
for authenticated direct telemetry; the shell assertion queried a dialog role
instead of the palette's combobox; the finder assertion matched multiple live
status regions. The shell and finder failures are test selector issues. The
printer telemetry failure needs follow-up before that flow can exercise its
resin assertions. The collection-hold and Integration API job lifecycle
journeys are not yet covered by this run.
