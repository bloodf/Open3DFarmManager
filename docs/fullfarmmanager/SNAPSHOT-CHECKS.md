# FullFarmManager snapshot checks

The read-only import was copied to a disposable scratch directory and all commands below ran from that copy, with `TMPDIR` set inside it. Results are from this run; stage documentation is evidence of claims, not proof of a successful current run.

## Commands

| Command                                     | Result and counts                                                                                                | Duration / decisive output                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --offline`                    | PASS; 5 workspaces, 111 packages installed from cache, 0 downloaded                                              | 3.9 s; esbuild install script was ignored by pnpm                                                                                        |
| `pnpm test:unit`                            | FAIL; preceding assertions passed; QR test did not execute successfully, and the loop stopped before later files | about 4 s; `ModuleNotFoundError: No module named 'cv2'`                                                                                  |
| `pnpm --filter @ffm/web typecheck`          | FAIL; TypeScript diagnostics (hundreds); no test counts apply                                                    | about 8 s; examples: `TS7006` implicit `any`, `TS2345` number not assignable to string or Date, and `TS7026` no `JSX.IntrinsicElements`  |
| `pnpm build`                                | FAIL; 0 successful Turbo tasks, 1 failed                                                                         | 38.7 s; Next compiled, then failed type validation at `src/components/StockDrawer.tsx:25` (`Parameter 'e' implicitly has an 'any' type`) |
| `pnpm preview:build`                        | FAIL; not built                                                                                                  | under 1 s; `Error: esbuild not found`                                                                                                    |
| `pnpm rebuild esbuild`                      | PASS as a package command, but did not make esbuild available to the preview scripts                             | under 1 s; no output                                                                                                                     |
| `pnpm preview:build` (retry)                | FAIL; not built                                                                                                  | under 1 s; `Error: esbuild not found`                                                                                                    |
| `pnpm test:smoke`                           | SKIP; requires the preview server and browser, neither can be prepared because preview build fails               | No routes run. The script checks 33 routes in each of `en` and `pt-BR` (66 route visits) when run.                                       |
| `pnpm test:api`                             | FAIL before test assertions; API and ops test files did not run                                                  | under 1 s; server bundle prerequisite failed with `Error: esbuild not found`                                                             |
| `pnpm --filter @ffm/web lint`               | SKIP; no lint script is declared in the web package                                                              | Not run                                                                                                                                  |
| `pnpm lint`                                 | SKIP; no root lint script is declared                                                                            | Not run                                                                                                                                  |
| `cd agent && go vet ./... && go test ./...` | PASS; vet clean; Go: 2 packages with tests passed, 2 packages have no test files                                 | under 1 s; `driver` and `internal/sim` passed                                                                                            |

The repository has no root `typecheck` or `lint` script. The web package declares `typecheck`; the production build also runs Next's type validation. `build` was run because it is explicitly defined and stayed within the 15 minute cap.

## Claims compared with this run

`docs/stages/S01b/SPEC.md` claims 74 unit checks, 48 API checks, 60 operations checks, a 16/16 S01b browser report, regressions across S00–S01, smoke coverage of all routes in English and Brazilian Portuguese, and successful `go test ./...`. The 74 unit checks claim could not be reproduced because the unit script stops at missing OpenCV; API/ops and browser claims could not be reproduced because esbuild is unavailable to the snapshot's offline build scripts. The Go test claim was reproduced, and `go vet ./...` also passed. Earlier S00 stage docs claim route and stage-report passes, but these are recorded report artifacts rather than runnable checks in `package.json`.

## Coverage

Executed JS unit assertions exercised database DDL/migration behavior, color math, simulated farm/catalog data, OAuth helpers, telemetry calculations and TOTP helpers before the QR test failed. They use generated/mock data; no real printer or LAN device was contacted. Go tests cover JSON shape compatibility and the in-memory simulator's command/state transitions. The API tests, which contain a simulated agent report and queued printer-command checks, did not get past bundle creation, so no protocol/API assertions ran. The checked smoke test is a static UI route-render check, not a printer protocol check. No Docker or simulator process was started.

## Cleanup

The scratch copy, its temporary directory, installed dependencies and generated output were removed after inspection. No containers, images, volumes, networks or long-lived processes were created. The external local task ledger records the scratch resource and baseline disk/worktree state.
