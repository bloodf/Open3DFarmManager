# KobraLink RTC first registration

The reusable runner executes a sealed rendered Nitro application, all 27
PostgreSQL migrations, restricted application roles, a private configuration
issuer, native Connector configuration signalling, Chromium and the pinned
unmodified KobraLink image with the original synthetic MQTT printer.

The current qualification is **blocked**. The real authority path reproduced a
PostgreSQL serialization failure while observing the browser account session.
Nitro returned HTTP 503. The browser did not reach observed identity confirmation,
commit, signed inventory acknowledgement or live farm telemetry. No positive
registration qualification is claimed.

The database error is `could not serialize access due to concurrent update`.
Its context is `farm.account_sessions ... FOR UPDATE`, called by
`SELECT farm.observe_signalling_session_expiry($1)::float8 AS now`.
The production implementation remains unchanged. The relationship between that
failure and the UI's uncertain-operation timeout requires product investigation.
The diagnostic transport wrapper forwards requests unchanged and records only
origin, path, method, status/error name and elapsed time. It records no body,
headers, cookies, credentials or query strings. No native fetch request was
observed in the last failing attempt; no KobraLink request timing is claimed.

## Comparison with the qualified upstream runner

`scripts/test-kobralink-integration.mjs` configures its observation client with
15,000 ms. Its first preparation uses `setupProvisioning()` and
`createProvisioningEngine(provisioning.options)`, without a timeout override.
That engine uses the client's 5,000 ms default, as does the production Connector.
Its authority callbacks return `true`; the browser qualification uses the real
PostgreSQL authority, signalling coordinator and signed receipts instead.

Both runs use image
`sha256:9865baa7346eb87d8860ced1881c30a1e5600b979d618c44757228407dce22e3`,
the isolated `172.30.78.0/24` fixture network, synthetic printer `172.30.78.3`,
LAN port 18910 and loopback management. The qualified runner uses a named volume;
this runner uses disposable tmpfs for the bridge database. Neither changes the
upstream image. The synthetic process uses the host UID to read its private TLS
files, and its readiness is checked before application startup.

The qualified runner's separate lost-response case deliberately loses a successful
create response, then reconciles by a known device ID. This first-registration
unit does not inject loss, retry creation or invoke recovery. Production deadlines
remain unchanged.

## Running

Use Node 24 and the workspace's frozen dependencies. Install with scripts ignored
and process-local `PNPM_CONFIG_ALLOW_BUILDS='{"esbuild":false}'`. Before starting
containers, run the separately reviewed private restart-owned v3 script. It must
verify the guest-port 53 ignore rule, owned loopback listeners and both exact
DOCKER-USER rules: subnet 77 drops all NEW traffic; subnet 78 drops external NEW
traffic. Keep the global context `orbstack`.

Run `node scripts/test-kobralink-rtc-acceptance.ts` with:

- `KOBRALINK_RTC_ADMITTED=yes`.
- `KOBRALINK_RTC_CONTEXT=colima-openfarm-kobralink-togiej`.
- `KOBRALINK_RTC_EVIDENCE` naming a private directory outside the checkout.
- `KOBRALINK_RTC_POSTGRES_IMAGE` naming the locally available digest-pinned
  PostgreSQL 17 image.
- `KOBRALINK_RTC_KOBRA_IMAGE` naming the pinned image above.
- `KOBRALINK_RTC_UPSTREAM_REVISION=5a5e5d9`.
- Distinct unprivileged `KOBRALINK_RTC_DB_PORT`, `KOBRALINK_RTC_HTTPS_PORT`,
  `KOBRALINK_RTC_KOBRA_PORT` and `KOBRALINK_RTC_MQTT_PORT` values.

The HTTPS fixture allocates its own loopback listeners; MQTT stays inside the
isolated fixture network and has no host listener. The runner creates unique
labelled containers and a unique network, refuses subnet collisions, never pulls
images and retains bounded logs, a sealed source/build receipt and desktop
screenshots privately. It seeds synthetic login/farm prerequisites only. Browser
key enrollment and approval, Connector pairing and printer registration use real
application boundaries. No authority stub or intercepted API response is used.

The UI driver fills the local IP and optional nickname while leaving device ID
empty. It checks that collection has not activated before confirmation and then
attempts confirmation and live farm status. Those later checks remain unexecuted
because preparation failed. Recovery, revocation, account switching and mobile
qualification remain pending.

Finally cleanup removes owned containers, anonymous volumes, the task network,
credentials, TLS files and the private build layer, then stops the dedicated VM
with `limactl stop`. Baseline images, network, profile and existing workspace
outputs remain. The exact admitted command and cleanup audit live in private
custody evidence, outside this repository.

Run admission tests with `node --test tests/node/kobralink-rtc-runner.test.ts`.
The first-registration gate intentionally fails while runtime status is blocked.
