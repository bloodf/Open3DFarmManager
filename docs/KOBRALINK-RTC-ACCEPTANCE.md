# KobraLink RTC acceptance

The reusable runner executes a sealed rendered Nitro application, all 27
PostgreSQL migrations, restricted application roles, a private configuration
issuer, native Connector configuration signalling, Chromium and the pinned
unmodified KobraLink image with the original synthetic MQTT printer.

The bounded positive first-registration chain is **qualified** (`pass`) for:

- `first_registration_without_device_id`: desktop `1280x900` registration on
  `/impressoras` using only the printer's local IPv4 (`172.30.78.3`) and an
  optional session nickname while leaving `device_id` empty, observing
  `OPENFARM_SYNTHETIC_KOBRA_X_001` over `config-v1` WebRTC before explicit
  confirmation and commit.
- `single_ui`: the entire workflow and live farm status execute inside OpenFarm
  without opening a second KobraLink dashboard, login page, popup or `iframe`.
- `inventory_before_live`: `local-commit` leaves the collector runtime
  `unconfirmed` (`result: "unconfirmed"`) and starts collection only after the
  server registers the signed receipt and returns a verified signed inventory
  acknowledgement (`inventory-confirmed` -> `result: "activated"`), followed by
  authenticated read-only WebRTC telemetry (`Conexão direta autenticada`,
  `Ociosa`) on `/farm` for a single canonical `kobra-x-...` assignment.
- `resource_cleanup`: owned containers, anonymous volumes, the isolated fixture
  network, temporary credentials, TLS files and build layer are removed in
  `finally`, and the dedicated VM is returned `STOPPED` with the global Docker
  context kept on `orbstack`.

## Final qualification: status **blocked**

The same real stack now runs seven isolated worlds, each with a fresh database,
bridge and synthetic printer: `positive`, `think-time`, `lost-reply`,
`late-ack`, `authority`, `account-switch` and `credential-expiry`. A
qualification passes only when every one of its checks was recorded during the
run and none failed; a check that did not run is `not-executed`, never a pass.
The machine-readable result is
[`docs/compatibility/kobralink-rtc-acceptance.json`](compatibility/kobralink-rtc-acceptance.json).

Executed and passing on the candidate:

- `first_registration_without_device_id`, `single_ui`, `inventory_before_live`:
  the accepted positive chain again, with its original assertions.
- `reload_reconnect_no_duplicate`: reload, signalling drop, Connector restart
  and a repeated registration (`identity-conflict`) keep one assignment, one
  bridge device and one creation call.
- `lost_ack_recovery`: the commit reply is lost; the page stays unconfirmed,
  a reload restores the same operation and a `status` request finishes it.
- `late_ack_fresh_authority`: the server registers the receipt but the
  acknowledgement never reaches the Connector, which does not collect. The
  expired transport's proofs get `403`, and the old acknowledgement is
  `rejected` both before and after a newly admitted `status`; only a fresh
  acknowledgement on the new transport confirms.
- `revoked_authority_refused`: owner and administrator succeed; viewer, revoked
  membership, revoked browser key, revoked Connector and an expired credential
  with the enrollment still approved are refused without any row, device or
  collection.
- `account_switch_isolated`: on one tab the other account neither sees nor
  restores the pending operation; a forged stored entry gets `403` for status
  and cancel; the owner still consults and cancels it.
- `mobile_keyboard_accessibility`: the form, identity confirmation, commit,
  live view and errors at 375 px with the keyboard only (errors also at
  1280 px), visible focus, labelled controls, no horizontal overflow.
- `resource_cleanup`.

Not passing:

- **Think-time (`think_time_lease_renewal`), product defect.** A prepare
  submitted with less than `MIN_CONTEXT_MS` of inbox lease left is refused
  before `config.ready`. Nothing reaches the Connector: no context request, no
  authority call, no prepare frame, no bridge call, no database operation. The
  page nevertheless keeps a pending operation; consulting it returns `403`
  ("Permissão negada…"), the cancellation cannot be confirmed and a reload
  restores the same card. The same refusal at commit time recovers correctly.
  Reproduce with `KOBRALINK_RTC_WORLDS=think-time`.
- `browser_secrets_absent`: no credential was found in any response, storage,
  console line, DOM or WebSocket frame that was read. It still fails because
  every refused session raises an uncaught `socket-closed` page error, and
  because one to three response bodies per world were unread when the bounded
  wait ended and are reported as unobserved rather than clean.
- `stale_error_capabilities`: unsupported controls and camera are absent and
  declared unavailable, and the unknown state is truthful. A fresh direct look
  at an offline printer was not obtained (repeated reloads reached the
  browser-device rate limit), so the offline label is not qualified.

## Limits

- The printer is synthetic. No physical printer, firmware or hardware is
  qualified; no physical command, camera, TURN or HTTP command fallback exists
  or was exercised.
- Isolated credential revocation is unreachable: the schema rejects a
  credential tombstone while the enrollment is approved. This is asserted on
  the real database and rolled back. It is not reported as passed through
  expiry.
- Lost replies, lost acknowledgements and replays are produced inside the page
  by dropping or repeating its own messages. No response, acknowledgement or
  authority is fabricated.
- The 10 000 ms proof TTL and the production `MIN_CONTEXT_MS` are unchanged.
  The harness reads the lease the server granted and chooses when to submit.
- Coordinator rerun and review remain required before publication.

## Diagnostic findings and lease boundary

Two separate conditions were resolved and verified through this harness:

1. **PostgreSQL serializable session expiry observation**: concurrent requests
   observing the same browser login session under `SERIALIZABLE` isolation can
   raise `SQLSTATE 40001` (`could not serialize access due to concurrent
update`) in `farm.observe_signalling_session_expiry`. With the integrated
   bounded serializable transaction retry in `PostgresConfigurationStore`, a
   concurrent `40001` during capability check retries cleanly in a fresh
   serializable transaction and returns HTTP `200`.
2. **Configuration inbox proof TTL vs. `MIN_CONTEXT_MS`**:
   `PostgresConnectorCredentialAcceptance` caps `accepted.expiresAt` at
   `challenge.issued_at + proofTtlMs`, and `acceptSignallingProof` honours the
   1,000 ms `0014` proof-slot throttle before completing `connectorProve`.
   `ConfigurationSignallingCoordinator.open()` requires at least
   `MIN_CONTEXT_MS` (5,000 ms) of remaining inbox lease when the browser sends
   `config.begin`. When the fixture supplied `proofTtlMs: 8000` (copied from
   read-only signalling instead of `docs/KOBRALINK-SELF-HOSTING.md`),
   `config.begin` at ~4,315 ms had only ~3,771 ms remaining before
   `inbox.expiresAt` (~8,086 ms) and was refused before `config.ready` or
   `rtc.offer`. Using the documented `OPEN3DFARM_CONFIGURATION.proofTtlMs` of
   `10000` (10,000 ms) while keeping all production constants and checks
   unchanged leaves >5,600 ms at `config.begin` and completes WebRTC session
   binding, mutual proofs, prepare, confirmation, commit, inventory
   acknowledgement and live `/farm` telemetry in one pass. Both the `8000`
   refusal trace and the `10000` passing trace are retained in private evidence.

The diagnostic boundary logger records only allowlisted WebSocket and data
channel frame types, WebRTC state transitions, HTTP status codes and elapsed
milliseconds. It never records tokens, proofs, capabilities, receipts, cookies,
SDP descriptions or request/response bodies.

## Running

Use Node 24 and the workspace's frozen dependencies. Install with scripts
ignored and process-local `PNPM_CONFIG_ALLOW_BUILDS='{"esbuild":false}'`. Before
starting containers, run the separately reviewed private `restart-owned.sh` v3
script. It verifies the guest-port 53 ignore rule, owned loopback listeners and
both exact `DOCKER-USER` rules: subnet 77 drops all `NEW` traffic; subnet 78
drops external `NEW` traffic. Keep the global context `orbstack`.

Run `node scripts/test-kobralink-rtc-acceptance.ts` with:

- `KOBRALINK_RTC_ADMITTED=yes`.
- `KOBRALINK_RTC_CONTEXT=colima-openfarm-kobralink-togiej`.
- `KOBRALINK_RTC_EVIDENCE` naming the absolute path to the ignored
  `.output/kobralink-rtc-evidence` directory in this checkout. External,
  tracked, unignored and symlink evidence directories are refused.
- `KOBRALINK_RTC_POSTGRES_IMAGE` naming the locally available digest-pinned
  PostgreSQL 17 image.
- `KOBRALINK_RTC_KOBRA_IMAGE` naming
  `sha256:9865baa7346eb87d8860ced1881c30a1e5600b979d618c44757228407dce22e3`.
- `KOBRALINK_RTC_UPSTREAM_REVISION=5a5e5d9`.
- Distinct unprivileged `KOBRALINK_RTC_DB_PORT`, `KOBRALINK_RTC_HTTPS_PORT`,
  `KOBRALINK_RTC_KOBRA_PORT` and `KOBRALINK_RTC_MQTT_PORT` values.

Optional `KOBRALINK_RTC_WORLDS` selects worlds for diagnosis; such a run is
never complete. `node scripts/test-kobralink-rtc-acceptance.ts --verify-report`
reads the committed report strictly and starts nothing.

Run admission tests with `node --test tests/node/kobralink-rtc-runner.test.ts`.

## Updated-base continuation

The cumulative harness checkpoint is preserved on the base containing the
pre-send recovery fix. Final qualification remains failed until selective
execution and the complete seven-world run on the accepted session-rejection
fix. The earlier report is historical evidence, not acceptance of this tree.

Offline reconnection now selects the approved browser device through the real
page lifecycle, with at most three spaced fresh admissions instead of repeated
page reloads. Unread response bodies retain sanitized path/status diagnostics
and still fail the secret audit. No page errors are newly allowed.

## Candidate 78605aa: think-time passes, positive blocked on offline observation

Status remains **blocked**. No seven-world run exists on this candidate, so the
committed report says `fail` and `--verify-report` rejects it.

- Think-time (run `a90e81cc`, head `78605aa`): 26 of 26 checks. A prepare
  refused near lease rotation returns to the form with no writes, the next
  fresh preparation succeeds, and the commit confirms after a real inbox
  renewal. 81 response bodies read, none unread, no page errors.
- Positive (run `86da29db`, head `5fce499`): 27 of 31 checks. With the
  synthetic printer offline the Connector admits a read-only session and ends
  it immediately with `source-unavailable`; the page shows no offline
  observation. This is a product defect owned by a separate unit. Positive and
  the full run are not repeated until its accepted SHA is integrated.
- The same run saw one `503` on the configuration bootstrap read during
  back-to-back navigations. Its cause is not logged by the route, so it is not
  allowlisted and still fails the network check if it recurs.
- Browser audit: each response body is now classified as read, bodyless by
  protocol, aborted by the browser, or unread. Only `net::ERR_ABORTED` excuses
  an unread body; anything else fails `browser-inspection-complete`.
- The stale check now waits for a live idle observation after the printer
  returns before the Connector is stopped.

Limits are unchanged: synthetic printer only, unknown firmware, no physical
qualification.

## Current integration positive run

Candidate `00c060dde1e12cde1805a508461e38682840efa3` on `f248e94` ran
positive world `de3c89dd-3d38-4713-b523-a2ce57d83657`. Offline observation
passed with the integrated fix. Registration, inventory ordering, reload,
reconnect and Connector restart preserved one bridge and device. All 354
response bodies were read; no secret search or HTTP status check failed.

Qualification remains BLOCKED: after synthetic MQTT resumed listening, no
new MQTT session/subscription appeared (accepted=1, queries=34 unchanged).
Three restoration checks did not regain idle before Connector stop. The
read-only runtime explicitly polls without reconnecting. A separate browser
warning reported /api/signalling/browser closed before establishment. Neither
failure is allowlisted. Full seven-world execution was therefore not started.
The report does not carry historical think-time passes onto this candidate.

The runner removed three containers, its network, private credentials and
build layer; the owned VM is STOPPED and global context remains orbstack.
Baseline images/network remain. Diagnostic logs and screenshots are retained
in the ignored evidence directory under the run ID. Desktop live screenshot
was inspected. Mobile qualification was not executed.

The browser warning was diagnosed from that run's boundary log. At 23554 ms,
after the Connector closed the read-only proof (23264 ms), the farm view
rediscovered three times in under 300 ms. A newer feed for the same slot
retired the older one. That one called `close()` on its signalling socket
while it was still CONNECTING. Chromium logs exactly this warning for that
call, and the socket reopened at 23647 ms. The page probe now records each
page-initiated close of a CONNECTING signalling socket. The audit excuses this
exact warning only when the same page and path have an unused recorded close,
matched one to one. Other WebSocket failures, types, paths and surplus
warnings still fail. This classification has not been through a runtime run
yet.

Repeat using the environment above and the reviewed v3 restart, then
`KOBRALINK_RTC_WORLDS=positive node scripts/test-kobralink-rtc-acceptance.ts`.
`--verify-report` must continue rejecting this incomplete report.
