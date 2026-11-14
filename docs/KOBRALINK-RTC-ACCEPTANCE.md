# KobraLink RTC first registration

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

Recovery (`reload_reconnect_no_duplicate`, `lost_ack_recovery`,
`late_ack_fresh_authority`), revocation, account switching, mobile keyboard
accessibility and explicit short-remaining-lease refusal belong to the next
acceptance unit and remain labeled `pending` here.

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
- `KOBRALINK_RTC_EVIDENCE` naming a private directory outside the checkout.
- `KOBRALINK_RTC_POSTGRES_IMAGE` naming the locally available digest-pinned
  PostgreSQL 17 image.
- `KOBRALINK_RTC_KOBRA_IMAGE` naming
  `sha256:9865baa7346eb87d8860ced1881c30a1e5600b979d618c44757228407dce22e3`.
- `KOBRALINK_RTC_UPSTREAM_REVISION=5a5e5d9`.
- Distinct unprivileged `KOBRALINK_RTC_DB_PORT`, `KOBRALINK_RTC_HTTPS_PORT`,
  `KOBRALINK_RTC_KOBRA_PORT` and `KOBRALINK_RTC_MQTT_PORT` values.

Run admission tests with `node --test tests/node/kobralink-rtc-runner.test.ts`.
