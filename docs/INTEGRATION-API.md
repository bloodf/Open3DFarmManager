# Integration API

The OpenFarm Integration API lets an application observe printers and inventory
and request actions under grants approved by a farm owner. The authoritative
contract is [`api/openapi-v1.yaml`](api/openapi-v1.yaml), published unchanged
as JSON at `/api/integrations/v1/openapi.json`. Use that document for exact
request and response schemas, scopes and error codes. This guide gives the
operational flow; the contract wins if the two disagree.

## Register an application and grant access

A farm owner registers an app in the pt-BR **Integrações** page. The client ID and secret are returned once; copy the secret immediately because it is never stored in recoverable form or shown again. Store it in a secret manager, never in browser code, source control or logs.

Owners can grant one or more scopes across a farm or limit them to a printer assignment, and can require owner approval for actions. Removing a grant immediately removes that access and invalidates tokens covering it. Only an active farm owner can use these session-authenticated management routes:

- `GET /api/farms/{farmId}/integrations/apps` lists apps and active printer assignments.
- `POST /api/farms/{farmId}/integrations/apps` registers an app and returns its client secret once.
- `DELETE /api/farms/{farmId}/integrations/apps/{appId}` revokes an app and all of its credentials and grants.
- `DELETE /api/farms/{farmId}/integrations/credentials/{credentialId}` revokes one app credential.
- `GET` and `POST /api/farms/{farmId}/integrations/apps/{appId}/grants` list or grant scopes.
- `DELETE /api/farms/{farmId}/integrations/grants/{grantId}` removes a grant.

### Scopes

| Scope              | Grants                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `printers:read`    | Read printers, their status, readiness and qualified capabilities.           |
| `files:read`       | List files stored on printers.                                               |
| `inventory:read`   | Read Spoolman inventory snapshots and the resin ledger (lots, vats, usage).  |
| `jobs:read`        | Read job history and API-submitted jobs.                                     |
| `jobs:start`       | Submit print jobs.                                                           |
| `control:basic`    | Pause, resume and cancel.                                                    |
| `control:extended` | Temperatures, fans, lights, speed, homing, filament and macros; list macros. |
| `events:subscribe` | Manage webhook subscriptions and receive events.                             |
| `jobs:write`       | Start a library replay on a granted printer.                                 |
| `library:read`     | Read library files and the storage mode.                                     |
| `library:write`    | Upload library files and set the storage mode.                               |
| `environment:read` | Read enclosure and room environment and power measurements.                  |
| `plates:confirm`   | Confirm that a printer's build plate is clear.                               |
| `alerts:write`     | Raise integration alerts for a farm. Reserved: no endpoint uses it yet.      |
| `camera:view`      | View printer camera snapshots. Reserved: no endpoint uses it yet.            |

Owners can grant the reserved scopes and tokens can carry them, but they
authorize nothing until an endpoint that requires them ships (`environment:read`
is already used by `GET /environment/measurements` and `plates:confirm` by
`POST /jobs/{id}/actions`). Any command an
endpoint later accepts under these scopes still travels as an issuer-signed
envelope that the Connector enforces and may refuse with a reason.

Revocations are audited and take effect on the next API request. Revoking an app
also makes its webhook subscriptions ineligible for delivery, including events
already waiting in the outbox.

The OpenAPI document below describes the separate client-facing API. Sandbox apps can be granted sandbox farms only; they cannot be attached to a non-sandbox farm.

Server-side storage of print files is out of scope for the integration API: [E7, #204](https://github.com/bloodf/Open3DFarmManager/issues/204) excludes it. Print library storage, retention and replay are specified in [PRINT-LIBRARY.md](PRINT-LIBRARY.md) (E17.1, [#373](https://github.com/bloodf/Open3DFarmManager/issues/373)) and are not part of this API until that document's implementation lands.

## Authenticate

Exchange the client credentials at `POST /api/integrations/v1/oauth/token`
using OAuth 2.0 client credentials. HTTP Basic (`client_secret_basic`) and
form-body (`client_secret_post`) are supported; do not send both. The response
includes `access_token`, `token_type` and `expires_in`. Cache the token only
until its reported expiry and send it as `Authorization: Bearer <token>`.
Session cookies are not accepted. A changed or revoked grant invalidates its
tokens. The token endpoint returns OAuth errors; other API errors use RFC 9457
`application/problem+json` and a stable `code`.

```sh
curl -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'scope=printers:read inventory:read' \
  "$OPENFARM_URL/api/integrations/v1/oauth/token"
```

## Read printers, state and inventory

Use `GET /printers` with `printers:read`; follow the opaque `nextCursor` as
`cursor` until it is `null`. `GET /printers/{printerId}/status` returns the
latest observed projection. Its `state` can be `unknown`, and optional readings
may be absent: do not infer readiness from missing data. `GET /inventory`
requires `inventory:read` and returns the Spoolman snapshot, including its
`stale` and `observedAt` fields. A snapshot may be stale and its spools list may
be a bounded subset of `total`. The Connector's Spoolman setup, active spool
sources, usage calculation and read-only behaviour are described in
[SPOOLMAN-INTEGRATION.md](SPOOLMAN-INTEGRATION.md).

### Observed spool page

`GET /inventory/spools` requires a farm-wide `inventory:read` grant. It
accepts `farmId`, `limit` (1–100), and an opaque `cursor`, returning `data`
and `nextCursor`. Each item includes the Connector, observation time, stale
and partial flags, and one spool summary. This pages the latest bounded
Connector observations; a partial snapshot omits spools, and a changing
snapshot can change page membership between requests. IDs are scoped to the
Connector's Spoolman service and may be absent in older observations.

### Spool snapshot identity

New Connector observations include `spoolId` for each spool. The ID belongs
to that Connector's configured Spoolman service, not to the display name;
older observations may omit it. The existing snapshot response retains its
original contract; compare the number of entries with `total` to identify a
bounded snapshot. The spool page labels each observation with `partial`.

### Spool finder and run usage

`GET /inventory/spools/search` and `GET /inventory/spools/usage` require a
farm-wide `inventory:read` grant and the spool usage database runtime.
Both accept `farmId` and `limit` (1–100, default 50).

Search reads the full OpenFarm spool library. Optional filters are `color`
(six hex digits, with an optional URL-encoded `#`), `material` (case
insensitive), `availability` (`any`, `stored`, or `loaded`), and
`minRemainingGrams`. Archived spools are excluded. Matches are ordered
by Euclidean RGB distance, then farm and spool ID. Colour filtering
excludes unknown colours and a weight threshold excludes unknown weights.
A missing location is `null`. The response includes `assessedAt` (Unix
milliseconds) and each active slot's `assignedAt` timestamp. Loaded
state reflects the library's assignment ledger at query time. Physical
find actions, label changes and bin LEDs remain in OpenFarm.

Usage accepts the numeric `id` from the history endpoint `GET /jobs`
as `jobId`, plus the optional `cursor` returned in `nextCursor`. Each
record includes the library spool ID, the source, grams and `observedAt`
(Unix milliseconds, the run end for telemetry and entry time otherwise).
Corrections retain the original `usageId` and observation time, replace
the grams and set `corrected`. Re-fetch the run to reconcile corrections
and upsert by `(farmId, usageId)` to avoid replaying stock movements.
Unattributed consumption has no spool ledger record.

Join finder results and usage records by `(farmId, spoolId)`. Connector
observations share that ID space when the Connector reads the farm's
OpenFarm Spoolman-compatible library. External Spoolman IDs belong to
their own service and can overlap with library IDs.

A `GET /printers` item may carry a read-only `specs` object with what the
Connector or printer profile reported: `buildVolumeMm` (`x`, `y`, `z` in mm),
`nozzles` (`[{ diameterMm }]`, one per tool), `spoolSlots` (integer) and
`multicolor` (boolean; `true` when more than one tool or spool slot is
reported, `false` only for exactly one of each). Unknown members are omitted,
and `specs` is absent when nothing is known; values are never defaulted per
model.

## Printer readiness and qualified capabilities

`GET /printers/readiness` with `printers:read` returns one page of readiness
summaries for granted printers. Each item reports `paired` (OpenFarm has an
assignment), `eligible` (Shop may treat the printer as ready to observe or, when
the operation allows it, control), `observedAt` (the last observation, or null),
`degradedReason` and `setupPath`. `setupPath` is an owner-facing path on this
OpenFarm server, such as `/impressoras/{printerKey}?farm={farmId}`. Open it in
OpenFarm to finish pairing or repair the printer. It is not a printer address
and it accepts no commands.

`eligible` is true only when the printer is paired, the latest observation is
present and not degraded, and the qualified operation is `supported-control` or
`monitoring-only`.

`GET /printers/{printerId}/capabilities` returns that operation and the catalog
evidence revision that justified it. Machine specs stay on `GET /printers` and
are not repeated here. `operation` is one of:

- `supported-control` — pause, resume and cancel are hardware-qualified for the reported firmware.
- `monitoring-only` — telemetry is hardware-qualified and control is not. Shop can observe the printer and must not start or control a job.
- `unknown-firmware` — the model matches a hardware-qualified catalog entry, but the reported firmware is absent or is not one of the recorded qualification versions.
- `temporarily-unavailable` — the catalog entry has hardware evidence, and the latest observation is degraded. Wait for a newer observation. Do not resend an uncertain command.
- `unqualified` — no hardware evidence covers this printer. Documented, simulated and unverified catalog rows do not enable operations.

Degradation is considered only after hardware evidence exists, so an unqualified
model stays `unqualified` while it is offline. Firmware is checked after
degradation. `catalogId` is the compatibility catalog entry, or null when
nothing matched. `evidenceRevision` is the SHA-256 of that entry's capability
grades, hardware-report paths, sources and, when the same brand and model are in
the fleet catalog, its evidence grades. It changes when that evidence changes.
It does not cover build volume or other machine specs.

`degradedReason` is `offline`, `reconnecting`, `error` or
`client-certificate-missing`, and null when the latest observation is not
degraded. A printer outside the grant answers `404 not-found`.

Recorded firmware versions used for `monitoring-only` are the hardware reports
for the Sovol SV06 (`Moonraker v0.11.0-4-gb559b9a`), the Snapmaker U1
(`Moonraker 2.0.0`) and the Anycubic Kobra X (`2.0.2.8`). A simulator build is
not one of those versions.

Other read operations include printer files (`files:read`), macros
(`control:extended`), job history (`jobs:read`) and individual job/action
status. File and macro listing are answered live by the Connector and may be
unavailable even when the printer list and status projection are readable.

## Resin and environment reads

Both are read-only. Switching, pairing and safety controls stay in OpenFarm and
are never reachable through these routes.

### Resin lots, vats and usage

`GET /resin/lots`, `GET /resin/vats` and `GET /resin/usage` require
`inventory:read`. They read the farm resin ledger: a farm-wide grant covers
every printer of the farm, a printer grant only its printer. Printers without
ledger entries are not listed. Pagination is by printer (`limit` counts printers;
follow `nextCursor`).

- Every quantity carries `source` and `observedAt`. `manual` is an operator
  record; `measured` is what the Connector reported. `observedAt` is when that
  ledger entry was recorded or reported.
- Unknown stays unknown: a bottle or vat without a recorded amount has
  `quantity: null` and `quantityState: "unknown"`. It is never `0`.
- The ledger has no lot register: `lotRef` is the label given to the bottle.
  The current vat (`current: true`) is the newest vat change; a reading taken
  before that vat's latest change is not applied to it.
- `/resin/usage` returns observed `readings` (newest first, at most 50 per
  printer) and `runs` (the last 20 finished runs). The ledger never ties a
  reading to a run, so each run has `consumption: { "state": "unknown" }`.
  Consumption is not estimated and never derived from a filament slot; compare
  measured readings and their `observedAt` yourself.

### Environment measurements

`GET /environment/measurements` requires `environment:read`, with the same
grant scoping and pagination as printers. Each printer lists `temperature`,
`humidity`, `air` and `power` measurements. A measurement is:

- `known`: `value`, `unit` and `lastObservedAt`.
- `unknown`: `reason` (`never-observed`, `offline` or `stale`) and, when
  something was seen before, `lastObservedAt`. A reading older than 60 seconds
  is `stale` and its old value is not returned.
- `unsupported`: the device does not report this measurement.

Today the Connector reports only the chamber fan speed (`air`, percent) to the
farm; `temperature`, `humidity` and `power` are `unsupported` until it observes
chamber/enclosure sensors and Moonraker sensors or power devices. Each printer
carries its `printerId`, `farmId`, `printerKey`, `displayName` and `location`,
so a storage warning can link to the responsible farm device.

## Start and track a job

Before submitting, fetch printer status and decide from current state whether
the operation is appropriate. Submit
`POST /printers/{printerId}/jobs` with `jobs:start` and a unique
`Idempotency-Key`. The JSON body contains an HTTPS `fileUrl`, lowercase SHA-256,
exact `sizeBytes` and `displayName`. The Connector fetches the file, verifies
its digest and size, then uploads and starts it. The server does not host the
file. A grant may hold the job for operator approval. Track it with the
returned job ID at `GET /jobs/{jobId}`; status can be `held`, `queued`,
`delivered`, `refused`, `started`, a final result, or `outcome-unknown`.

A library replay uses the same endpoint with `libraryVersionId` (and an
optional `plate`) instead of a URL. The grant needs `jobs:start` and
`jobs:write`. `GET /library` and `GET /library/{itemId}` (`library:read`)
return the farm's storage mode. `POST /library` stores the file in that mode,
and `PATCH /library/settings` (`library:write`) changes it. The Connector
prints the stored file and refuses a printer the file does not fit.

### Plate checks at dispatch

Read `GET /jobs/{jobId}/eligibility?printerId={printerId}` for an advisory
eligibility decision and its reasons. Use
`GET /jobs/{jobId}/plate?printerId={printerId}` for the plate observation alone.
Both reads accept `jobs:read` or `jobs:start` and require the job's assigned
printer. For Moonraker, the Connector combines live printer state with its
collection journal. The plate state is `awaiting-collection`,
`operator-confirmed`, or `unknown`. An available attempt ID identifies the
journal entry. Eligibility requires a pending job, an idle printer and a
confirmed plate. For a stopped Moonraker printer with no collection history,
the read reports `unknown` with attempt ID `0`. An operator can inspect and
clear the bed, then acknowledge that initial attempt before the first API
start.

For a signed start, the Connector checks its local collection journal before
staging the file and again at the printer send boundary. A start refused with
`wrong-state` may include `awaiting-collection` when a completed run still
requires plate clearance, or `plate-state-uncertain` when the Connector cannot
establish clearance from its journal. Resolve the plate state locally before
submitting another start.

### Acknowledge plate clearance or control a job run

Send `POST /jobs/{jobId}/actions` with an `Idempotency-Key` and JSON.
The job must belong to the calling integration, and the grant must cover its
assigned printer. A grant that requires operator approval holds the action.

- For plate clearance, use `plates:confirm` and send
  `{"action":"confirm_collection","args":{"attempt":"<attemptId>"}}` after an
  operator clears the bed. Take the attempt ID from the plate read for the
  assigned printer. The Connector records the acknowledgement while the
  printer is stopped. Confirming the current collected attempt again is safe.
  An older attempt cannot release a newer hold. The refusal details are
  `plate-attempt-mismatch` and `plate-state-uncertain`.
- For job control, use `control:basic` and send `pause`, `resume`, or `cancel`
  with `"args":{}`. The Farm binds the command to that job's original start
  envelope. The Moonraker Connector checks the active run immediately before
  dispatch and reports `already-ended` for a stopped printer or
  `run-mismatch` when it cannot verify that the active run is the expected one.

Follow the response's `Location` to read the action result. Reuse the same
idempotency key and request to retrieve the existing action, including after
a lost response. An `outcome-unknown` requires reconciliation before making
another request. The service never automatically retries an uncertain write.

## Request actions

`POST /printers/{printerId}/actions` also requires an `Idempotency-Key`.
`pause`, `resume` and `cancel` require `control:basic`; other supported actions
require `control:extended`. Send the action and its `args` as specified by the
OpenAPI schema (use `{}` for actions without arguments), then track the result
with `GET /actions/{actionId}`. The printer must advertise the action. Check
printer state immediately before each command and account for the possibility
that it changes between the check and delivery.

Never automatically retry an uncertain command. Reuse the same idempotency key
and identical body only when intentionally retrying a request whose outcome is
known to be safe; changed bodies with a reused key receive
`idempotency-key-reused`.

## Handle errors and Connector refusals

For API errors, branch on the problem `code`, not its human-readable `title` or
`detail`. `401 invalid-token` means obtain a valid token; `403 insufficient-scope`
means the owner must grant the required scope. Out-of-grant resources return
`404 not-found` to avoid disclosing their existence. `429` includes
`Retry-After`; honor it. Authenticated responses include `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset` for the bucket used. Read and write
limits are separate, per app, and can change; follow these headers rather than
hard-coding budgets.

The Connector is the final safety authority and can refuse a signed command.
Job or action responses carry a `refusal.code` when status is `refused`. Current
codes are `printer-busy`, `not-ready`, `wrong-state`, `checksum-mismatch`,
`grant-revoked`, `expired` and `unsupported`. Treat every refusal, including an
unknown future code, as a refusal; do not work around it or automatically
resubmit. Surface the reason and check printer state before taking any further
action. `outcome-unknown` means delivery or execution could not be confirmed;
the system did not retry it. Reconcile against current printer state and job
history before deciding what to do.

## Webhooks

Create a subscription with `POST /webhooks` (`events:subscribe`), then keep the
returned `signingSecret` private; it is shown only once. Verify the exact raw
request bytes before parsing JSON. The signature is HMAC-SHA256 over the UTF-8
bytes of `<OpenFarm-Timestamp>.<raw-body>`, encoded as lowercase hex in
`OpenFarm-Signature: v1=<hex>`. Compare signatures in constant time, enforce a
reasonable timestamp age, and use `OpenFarm-Event-Id` for deduplication. During
secret rotation the header may contain multiple signatures; accept if any
`v1=` signature verifies. Respond successfully only after accepting the event
for processing. Treat event payloads as extensible and ignore unknown fields
and event types.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyWebhook(
  rawBody: Buffer,
  timestamp: string,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!/^\d{1,16}$/.test(timestamp)) return false
  const timestampValue = Number(timestamp)
  const timestampMs =
    timestampValue < 100_000_000_000 ? timestampValue * 1000 : timestampValue
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000
  )
    return false
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest()
  return signatureHeader.split(',').some((item) => {
    const match = /^\s*v1=([0-9a-f]{64})\s*$/.exec(item)
    if (!match) return false
    const candidate = Buffer.from(match[1]!, 'hex')
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    )
  })
}
```

## Sandbox and reference client

Use a sandbox app and sandbox farm for development. Sandbox credentials can
never authorize a non-sandbox farm. Keep sandbox and production credentials,
data and base URLs separate. The reference client in
[`../examples/integration-client/`](../examples/integration-client/) has
offline tests and an explicitly opt-in sandbox journey. `startPrint`,
`pausePrint` and `cancelPrint` send the published job and action operations;
authenticate with `jobs:start` and `control:basic` before calling them.
`tests/e2e/epic-204.spec.ts` runs that client against a loopback sandbox, a
simulated Moonraker printer and the Connector, which accepts only a signed
envelope. The run does not contact a physical printer.

With Node 22 and workspace dependencies installed, run the offline command checks:

```sh
node --test tests/unit/api-v1-contract.test.ts
node --test tests/node/connector-api-envelope.test.ts tests/node/integration-client-example.test.ts
```

The contract suite starts an isolated sandbox fixture on loopback. The
reference client authenticates and submits a job, pause and cancel through
the v1 middleware and route handlers. The fixture signs each queued
command and delivers it over HTTP to the Connector envelope runner.
The runner verifies the envelope and authority, downloads and checks the
HTTPS fixture, uploads it to synthetic Moonraker and sends the commands
in order. The test checks each observed printer state, the Connector
outcomes and the client exchanges against the published OpenAPI source.

The fixture uses in-memory stores and a test inbox. The Compose sandbox,
production WebSocket inbox and physical printers require separate
validation. The Node contract entry point runs the Vitest suite and
propagates failures.

## Versioning and compatibility

The major version is in the path (`/api/integrations/v1`). Compatible additions
may introduce optional fields, operations, event types and response enum
values. Ignore unknown response fields, treat an unknown status as non-final,
an unknown refusal code as a refusal, and use HTTP status when an error code is
unrecognized. Follow cursors, token lifetime and rate limit headers rather
than assuming fixed values. Deprecation notices and the minimum notice periods
are defined by the OpenAPI contract and release notes. Security fixes may
change behavior within v1 when needed to protect owners or printers.

## Out of scope

E7 does not provide the print-library storage, retention or replay contract;
see [PRINT-LIBRARY.md](PRINT-LIBRARY.md).
