# E6 frontend implementation checkpoint

This document retains the initial frontend slice and its later integration evidence. The rendered page now has actual HTTPS/PostgreSQL/RTC acceptance with the packaged Connector and an original Moonraker protocol fixture, recorded below. Genuine pinned Moonraker/Klipper, camera and command acceptance remain incomplete.

The implementation started from `e7ae65eb81dcbfed838c8e571f6fddb39c69aa68`. Concurrent documentation advanced the shared branch to `43948542a802384e7ae6550a7a214593645816db` during this task. The coordinator records the resulting candidate commit and built-artifact identity when the remaining integration work settles. No application artifact was built in this task.

## Implemented behavior

`apps/farm/app/pages/farm.vue` retains its existing feature gate. The page uses native controls, pt-BR copy, focusable headings and error summaries, wrapped exact printer keys, separate assignment and Connector approval labels, and an unconditionally disabled pause button. The root coordinator owns the conditional home navigation link. Login and existing management pages are unchanged.

`apps/farm/app/utils/farm-view.ts` validates current-account, farm-discovery, assignment, and registry responses before presentation. Farm and assignment pages replace previous pages, request 20 rows, and use actual UUID cursors. Only a complete first discovery page containing one farm is auto-selected. Names, printer counts, URLs, and operational state are never inferred from inventory. Loading, empty results, authentication failures, forbidden access, rate limits, malformed responses, and unavailable services remain distinct.

Current-account reads bracket discovery and assignment reads. Registry pages also carry `currentAccountId`. Approved local keys are joined by current account and exact thumbprint to approved registry key IDs with recorded possession proof. All registry pages must be read before selection. The scan stops after 32 pages and reports an incomplete result without claiming that an unseen key is missing. Multiple candidates require selection. Local enumeration uses `listDeviceKeys`; it never invokes key creation, enrollment, recovery, or legacy key fallback. Storage or registry failures leave independently confirmed inventory readable, but observed 401, 403, or account mismatch clears private state.

`apps/farm/app/composables/useFarmView.ts` holds state per mounted page without an authenticated Nuxt singleton or private server-rendered payload. Selection, refresh, pagination, key changes, route exit, and disposal invalidate callbacks before aborting pending reads and closing feeds. Scope changes clear observations and local links conservatively, including inventory refreshes. Focus, visibility changes, `pageshow`, and `pagehide` suspend private presentation and revalidate when visible. The optional `open3dfarmmanager:auth-invalidated` window event only triggers invalidation and fresh reads. Existing auth pages do not emit this event yet.

Two `/api/auth/me` reads do not provide an atomic session snapshot. Farm and assignment responses do not echo an account or session generation, cookie changes are not directly observable, and equal account IDs do not detect session rotation. Immediate cross-tab revocation and real account-switch races remain auth and transport acceptance requirements.

## Status-consumer contract

The production composable creates the authenticated feed and existing-key resolver only after mount. Resolution must still match the current account, farm, view epoch and selected key; unavailable signalling metadata rejects admission. No experiment peer or synthetic producer is imported into application runtime. Runtime composition and built-page HTTP/PostgreSQL/RTC now have the bounded protocol-fixture evidence below; genuine simulator acceptance remains pending.

The exported `FarmStatusFeed` opens one read-only subscription per eligible Connector represented on the visible assignment page. Each subscription receives that Connector's complete validated active assignment tuple set across the farm, rather than just the visible rows:

```ts
open({
  scope, // accountId, farmId, viewEpoch
  agentId,
  assignmentRefs, // complete immutable assignmentId, agentId, exact printerKey set
  browserKeyId,
  signal,
  onHealth,
  onSnapshot,
}): { close(): void }
```

The producer must authorize the current session, membership, browser key, Connector, and assignments. It must verify the actual RTC transcript, certificate, and mutual proofs before emitting `authenticated`. `FarmAdmittedSession` is display metadata, not an authorization credential. It contains `transportId`, `peerGeneration`, `accountId`, `farmId`, `agentId`, `browserKeyId`, `expiresAt`, and `deadlineMonoMs`. Private keys, bearer credentials, proofs, and SDP never enter page state.

`FarmSnapshot` contains that fixed session, a protocol `StatusMessage`, local receipt timestamps `receivedAtWallMs` and `receivedAtMonoMs`, explicit `sourceClockComparable`, and `complete: true`. The producer must define complete snapshots for the subscribed Connector and fit the existing 2,048-byte application-frame budget. Raw-frame decoding must reject duplicate JSON properties and enforce the actual wire-byte limit before producing this parsed callback. The consumer additionally validates strict protocol schemas, safe timestamps and sequence numbers, duplicate printer keys, and the serialized parsed-message budget. This check does not replace producer wire validation or widen the peer budget. No chunking protocol is introduced.

The consumer checks the exact view, assignment, key, transport, and peer generation. Only increasing sequence numbers update observations. A snapshot must contain exactly the complete subscribed printer-key set. A missing or extra key closes the feed and leaves previous observations historical without refreshing their age. Hidden printers in a valid complete snapshot never create visible inventory rows. Regressing source timestamps and changed content at an equal timestamp retain the previous observation as uncertain history. Repeated identical source data cannot hide a clearly old source observation.

Receipt age uses monotonic time. The display stale threshold is 30 seconds, inclusive. A comparable old source timestamp also marks data stale. Future source time, clock regression, or wall-to-monotonic divergence removes source-time confidence. The page reports uncertainty and never labels a recent packet as verified fresh printer data. Transport state remains separate from last printer state.

The consumer closes terminally at the original session deadline, wall-clock expiry, or 30 seconds after subscription, whichever occurs first. The producer remains responsible for its own stricter local expiry and current authority. Repeated authentication callbacks cannot change the original session or extend its lease. Disconnect, rejection, revocation, and expiry leave only same-scope historical observations, and late callbacks cannot restore a closed feed. A new genuinely admitted transport requires a new subscription.

Loss detection and reopen are view-owned and timer-free: the composable's one-second tick drives both. A feed that delivers no newer frame for 9 seconds closes, so a silent P2P stall becomes read-only, historical data within 10 seconds; a disconnect or open failure is read-only immediately. A lease end on a healthy feed (data for at least 10 seconds, last frame under 9 seconds old) is a renewal: rows keep their live connection and observation while a fresh subscription opens at once, transient connecting/verifying steps stay hidden, and liveness still closes the rows 9 seconds after the last frame if the renewal does not deliver. Healthy renewals skip the HTTP authority re-check; the producer and signalling server enforce current authority at every admission, so a revoked renewal fails to admit and falls into the reopen path below. Any other close except `revoked` and `rejected` schedules a reopen after `min(30 s, 1 s × 2^n) × [0.5, 1)` jitter, where `n` counts consecutive unhealthy subscriptions; at most six reopens (seven subscriptions) run before the view waits for the next revalidation (focus, page show or visibility change). Each reopen first re-reads identity and the complete assignment scan, because the browser cannot observe a signalling 403 or a server-side revocation. All Connectors of one run share one in-flight scan (reused for 1 second after it settles). 401/403 or an account change fail the view; a revoked Connector or changed assignment set refreshes the current farm page so statuses and feeds match the server; 429 waits for `Retry-After` (else 30 seconds) without spending the reopen budget. `revoked` and `rejected` (invalid or tampered feed) stop immediately. The feed reports `rejected` only for validation failures: a callback that arrives after its lease or deadline lapsed, before the expiry timer runs, closes as `expired`, and local slot capacity or a view-callback fault closes as `disconnected`. Auth invalidation, logout, farm/key change, route leave and unmount retire the run, which cancels any pending reopen. The page's `role="status"` notice announces only live ↔ unavailable changes; per-row text carries transient steps.

The Connector runtime owner must install the complete fresh snapshot provider alongside the genuine client and document its bounded publishing strategy and disposal behavior. Opening a WebSocket, ICE connectivity, registry approval, a proof fixture, or `fixture-idle` cannot satisfy this contract. There is no command, signing, media, arbitrary-URL fetch, HTTP status fallback, or TURN method on the port.

## Local-interface navigation

Each eligible active row accepts an explicit HTTP or HTTPS root origin with a labeled confirmation checkbox. The page shows the normalized origin before retention. Credentials, whitespace, control characters, backslashes, query strings, fragments, non-root paths, and path-normalization tricks are rejected locally. Private DNS, private IPs, and loopback remain deliberate supported destinations.

The confirmed origin stays inside the current account, farm, assignment, Connector, and exact-key row in tab memory. Scope invalidation, assignment replacement, or revocation removes it. There is no persistence, server write, address probe, prefetch, proxy, iframe, or programmatic window opening. The external anchor uses `target="_blank"`, `rel="noopener noreferrer"`, and `referrerpolicy="no-referrer"`. Clicking is ordinary explicit browser navigation, independent of application command authority.

## Verification and remaining gates

The coordinator released the CPU restriction for focused tests, formatting, and static typing. These checks passed:

- `bun test tests/unit/farm-view.test.ts` (historical, pre-pnpm; now Vitest): 24 tests, 161 assertions. All feed events are explicitly synthetic unit inputs.
- Standalone strict TypeScript over the utility, unit tests, and opt-in e2e file, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled.
- `apps/farm/node_modules/.bin/vue-tsc --noEmit --incremental false -p apps/farm/.nuxt/tsconfig.app.json`, using the pre-existing generated app configuration without Nuxt preparation or build.
- Prettier on the six owned files and `git diff --check`.

`tests/e2e/farm-view.spec.ts` adds three isolated UI scenarios for native controls, 320px layout, exact escaped keys, external-anchor privacy attributes, no outbound local-address probe, focus invalidation, sign-in, and service failure. These tests are gated by `FARM_VIEW_E2E=true` and require a separately supplied built app with `farmView` enabled. Use `FARM_VIEW_E2E=true pnpm exec playwright test --config playwright.farm-view.config.ts` after building the app; set `FARM_VIEW_PORT` to move off 3101. The file also holds four axe-core WCAG A/AA scans (320px and 1280px inventory, open/confirmed local-interface form, sign-in and error states). This dedicated configuration enables only the farm-view scenarios on loopback port `FARM_VIEW_PORT` (default 3101; empty uses the default, otherwise an integer 1-65535) and leaves the default flag-off launcher on its own port. Locally observed on 2026-11-11 at commit 91f4ea8 (Chromium 1254, Linux amd64): `FARM_VIEW_E2E=true FARM_VIEW_PORT=22401 pnpm exec playwright test --config playwright.farm-view.config.ts` reported 7 passed, 0 failed. Mocked routes cannot prove genuine login, database, or RTC behavior. The default flag-off suite is unchanged.

The following integration evidence is still required on one immutable candidate: `pnpm run check:all`; built HTTPS own-login and home-to-farm navigation; real PostgreSQL pagination and authorization scopes; approved nonextractable local browser keys; genuine admitted direct RTC simulator observations; stopped-feed age behavior; account, session, assignment, and revocation races; outages and bounded recovery; deliberate isolated local-interface navigation; keyboard, screen-reader, contrast, and responsive review. Signed pause and camera retain separate acceptance gates. No physical-printer command is authorized or tested by this slice.

No dependency was added. No install, build, browser, network, database, container, simulator, worktree, or persistent application process was started. Focused checks created no task-owned build output. Pre-existing dependencies, generated Nuxt files, application output, worktrees, processes, and other workers' edits were preserved. The outside-repository task ledger retains the resource baseline and bounded verification evidence. No publication or deployment occurred.

Teardown now detaches old resources and captures each new run before invoking producer close or abort listeners. A superseded outer operation cannot publish or adopt the reentrant run's generation; terminal callbacks also recheck scope after teardown. The focused reentry regression covers key selection and a terminal feed event, checks the winning key and late-callback isolation, and requires all superseded handles to close. The focused suite now has 25 passing tests with 181 assertions; browser and genuine transport acceptance remain separate.

## Complete assignment scope source preparation

The visible inventory still requests and displays one page of at most 20 rows. When a genuine feed is configured and an eligible visible Connector has a selected browser key, the consumer first reads a new complete inventory scope from the maintained printer-inventory endpoint. Each request uses limit 20 and the existing strict response schema. The scan is bounded to 32 pages and 640 records, validates every returned page, rejects cursor cycles, duplicate assignment IDs, duplicate active agent/printer-key pairs, inconsistent Connector approval status, and missing or contradictory visible tuples. Current-account reads bracket this scan. The complete tuple arrays are copied and frozen only after terminal pagination and account validation.

Only agents represented by eligible visible rows open feeds. Each receives its complete active/approved set from the scan; hidden agents do not open transports. A conservative complete-frame size check includes escaped UTF8 keys and numeric JSON headroom within the unchanged 2,048-byte limit; groups exceeding that budget or the existing 100-printer peer bound remain unavailable. The consumer does not truncate, split, invent a missing assignment, or read Connector configuration to infer authority. The genuine peer and server retain all current authorization duties.

Feed admission starts after the scan finishes, so inventory loading consumes none of the peer's original authentication budget. State exposes `feedScope` independently of key availability: disabled, idle, loading, ready, or unavailable. An incomplete, malformed, contradictory, or over-cap scan leaves independently validated visible inventory and key choices readable while admitting no feed. Observed account mismatch, 401, or 403 still clears private state through the existing failure path. Consumers without a feed make no extra scan requests.

Key selection, pagination, refresh, reentry, invalidation and disposal retire the old view generation before teardown and invalidate pending scans. No complete-set cache crosses these boundaries. Late pages cannot open old transports or replace winning tuples. Complete snapshots update visible rows only; the complete hidden set is held privately by the transport subscription. This paginated read is not an atomic database snapshot and cannot detect every concurrent hidden insertion or session rotation. Exact peer set validation remains fail closed, and current server authorization is still required.

The maintained focused suite passes with 32 tests and 250 assertions. It covers split-page Connector scope, mixed agents, incomplete/cyclic/duplicate/contradictory inventories, capacity limits, changed account, late scans, refresh, revocation and key replacement. The first run retained one failing legacy fixture that sent partial printer updates. That fixture now establishes a complete snapshot and asserts that a later partial update closes the feed without refreshing either row. Scope validation was not weakened. Root TypeScript and the installed generated-app `vue-tsc` check also pass; the test helper now uses the actual protocol printer type rather than inferring only the literal printing state. Prettier and diff checks pass for the three owned files.

No build, browser, network, database, simulator or native peer ran for this addition. Checks created no task-owned generated application output; only bounded external verification logs are retained. Pre-existing dependencies, generated files and other workers' resources remain unchanged. Genuine production status acceptance remains pending runtime composition and exact-artifact integration.

## Rendered page and packaged runtime acceptance

At `422e83f0b9d5df40555848a5b81c1f7a7b78d66a`, the actual generated `/farm`
page passed separate disconnect and revocation cases in 11.431 and 13.931
seconds. The fixture enabled the existing farm flag only in its private runtime.
It used real independent login, browser-key registration and approval, Connector
pairing, issued credential, assignment readback and official PostgreSQL journal
through 0019. No application API or RTC response was intercepted.

The explicit fixture enrollment created a nonextractable P-256 key with the
maintained IndexedDB API. A separate page in the same context then loaded the
existing key through the production composable and resolver. Its sole farm and
approved device were selected by the maintained view. The packaged Connector
received original loopback Moonraker subscribe/query responses and a subsequent
progress delta. The actual page displayed authenticated connection, progress
0.25 then 0.75, uncertain source clock, and a disabled pause button. A real
proxy signalling disconnect or owner HTTP revocation changed the displayed
connection to unavailable while retaining only the previous observation. Pause
remained disabled and no later status restored authentication.

The initial page run and a bounded diagnostic run failed with a subsequent
`/api/auth/me` 401. A separate actual PostgreSQL lock barrier reproduced the
session adapter rejecting a request timestamp captured before a concurrent
touch. The corrected adapter observes time after the account/session locks,
without clamping regressed clocks. Three actual restricted-role tests passed:
concurrent touch with the wall clock, plus controlled-clock expiry and regression
after actual lock contention. Fixed
historical timestamp fixtures explicitly retain their synthetic observer.
The test also stopped redundantly reselecting the already auto-selected single
scope. The initial receipts and one Node strip-only syntax failure in the new
regression runner remain preserved.

The sealed HTTPS output has 457 files and digest
`3e0d2a5a7e44cc14abfbce28b03e80a8dde936c0793a2326a857c2acf942c8cd`.
The package manifest remains the nineteen-file digest recorded in
[the Connector runtime checkpoint](CONNECTOR-RTC-RUNTIME-CHECKPOINT.md).
Independent audits confirmed all recorded test processes, ports, private
directories and login roles removed, with the original database identity,
journal and eleven table counts equal to baseline. The owned integration
database and bridge remain intentionally retained.

This is genuine application-page and authenticated transport evidence using
a protocol fixture, not a pinned Moonraker/Klipper process. Browser TLS retains
the private fixture's ignore-certificate-errors limitation. It does not prove
production TLS deployment, cross-tab session rotation, every inventory race,
camera, signed pause or physical-printer behavior.

The final complete source check passed 326 Bun tests, 383 Node tests and two
runtime skips, lint, TypeScript and both builds. This checkpoint update changed
only documentation after those checks; its formatting and whitespace checks
passed separately. No publication or complete Phase 0 acceptance is claimed.
