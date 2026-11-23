# Spoolman integration guide

OpenFarm reads Spoolman to show filament inventory, the spool each printer tool
uses, and filament consumed per job. The integration is **read-only**: the
Connector issues only `GET` requests to Spoolman and never writes spools,
filaments or vendors. Spoolman itself is installed and operated separately.

This guide covers setup, which spool sources are used, how usage is
calculated, and how to verify a connection against the simulator. The
protocol details live in [SPOOLMAN-MIRROR.md](SPOOLMAN-MIRROR.md); the farm
page flow is in [SPOOLMAN-FARM-CONFIG.md](SPOOLMAN-FARM-CONFIG.md); the public
read contract is in [INTEGRATION-API.md](INTEGRATION-API.md) and
[`api/openapi-v1.yaml`](api/openapi-v1.yaml). The built-in spool library storage
and the per-farm credential for existing Spoolman clients are described in
[SPOOL-LIBRARY-STORAGE.md](SPOOL-LIBRARY-STORAGE.md); this guide's external
Spoolman integration is unaffected.

## 1. Requirements

- A Spoolman service reachable from the Connector's host over `http://` or
  `https://`. Use a canonical origin: scheme, host and port only, with no path,
  query, or user information.
- A farm with at least one Connector that has a runtime configuration and at
  least one printer. A Connector without that configuration answers
  `not-available` to the farm setting.
- A farm owner or administrator to set the Spoolman address in the pt-BR
  **Spoolman** page.

## 2. Setup

There are two ways to point a Connector at Spoolman. Both store the same
non-secret address and identifiers.

### 2.1 From the farm page (recommended)

1. Open **Spoolman** in the farm (owner or administrator).
2. Enter the origin. Add a token, or a username and password, only if the
   Spoolman instance requires them.
3. The browser sends the setting to each approved Connector over an
   authenticated `config-v1` session. The Connector tests the connection and
   answers either a prepared receipt or one of two errors:
   `spoolman-unreachable` or `spoolman-unauthorized`.
4. On commit the Connector writes `collection.spoolman` into its runtime
   configuration. Credentials go into `credentials/spoolman.json` (mode 0600).
   The server never receives them.

A failed test never replaces a setting that is already applied.

### 2.2 Local Connector configuration

The Connector's private local runtime configuration takes an optional
`collection.spoolman` section:

```json
{
  "origin": "http://spoolman.lan:7912",
  "farmId": "<farm UUID>",
  "serviceId": "<UUID that identifies this Spoolman installation>",
  "limit": 200,
  "credentialFile": "credentials/spoolman.json"
}
```

| Field            | Rules                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `origin`         | Canonical `http(s)` origin. Read only from this private file, never from signalling or browser requests.                  |
| `farmId`         | UUID. The runtime rejects the configuration when it differs from the farm of the Connector's local credential.            |
| `serviceId`      | UUID. Keeps identical Spoolman IDs from different installations apart.                                                    |
| `limit`          | Integer from 1 to 200, default 200. Page size only; it does not change any budget.                                        |
| `credentialFile` | Optional. Private file holding `token` or `username`/`password` bound to the same `origin`. Ignored for any other origin. |

Absence of `collection.spoolman` disables all Spoolman network activity.

## 3. What the Connector reads

### 3.1 Inventory

The Connector builds one observed inventory from the Spoolman REST endpoint
`/api/v1/spool` (with `allow_archived=true`, sorted by ID), and then keeps it
current from the root `/api/v1/` WebSocket:

- Spool, filament and vendor added, updated or deleted notifications mark the
  inventory `stale` at once and schedule a fresh read. Bursts coalesce into one
  traversal, with at least one second between reads.
- A periodic reconciliation read runs about every fifteen seconds.
- A reconnect performs a fresh read. Data older than thirty seconds is `stale`
  even before a disconnect is detected.
- Failed reads and disconnects keep the last inventory, marked `stale`.

Archived spools are included and flagged `archived`. Consumers must not treat
them as available.

The inventory is an **observed traversal**, not an atomic snapshot. If Spoolman
changes during a traversal, rows can be missed until the next read.

### 3.2 Active spool per tool

For each printer, the Connector resolves the spool a tool is using, in this
order:

1. **Moonraker's active spool.** The Connector asks Moonraker
   `server.spoolman.get_spool_id`. A positive ID that matches the inventory is
   used for the `external` slot.
2. **Manual per-tool assignments.** When Moonraker has no active spool, the
   Connector uses per-slot assignments from its local assignment store
   (`createActiveSpoolAssignmentStore`). Each assignment is a slot name plus a
   Spoolman spool ID. This repository provides the store and the resolver; it
   provides no screen or API that creates assignments yet.

An ID that is not in the current inventory produces no active spool; the
Connector does not guess one.

### 3.3 Limits

| Limit                          | Value                          |
| ------------------------------ | ------------------------------ |
| Page size (decoded)            | 256 KiB                        |
| Whole traversal                | 4 MiB, 10,000 items, 256 pages |
| Request and traversal deadline | 10 seconds                     |
| Redirects                      | refused                        |
| Methods                        | `GET` only                     |

Exceeding a limit rejects the whole traversal. No partial inventory is
published.

## 4. Filament usage per job

Moonraker reports the total filament length of a job in millimetres. The
Connector converts it to grams with the selected spool's material data:

```
grams = millimetres × π × (diameter_mm / 2)² × density_g_per_cm³ ÷ 1000
```

- `diameter_mm` and `density_g_per_cm³` come from the spool's filament in
  Spoolman (`filament.diameter`, `filament.density`).
- The material used is the single active material. If none is marked active and
  the printer reports exactly one material, that one is used. Otherwise the
  material is unknown.
- `tool` is the material's slot, or `unknown`.
- When diameter or density is missing, `grams` is omitted. The length in
  millimetres is still recorded.

Per-tool usage appears in the job history entry as `filamentUsage` (see
`FilamentUsage` in [`api/openapi-v1.yaml`](api/openapi-v1.yaml)). It is recorded
at job end, when known. The `inventory.changed` event is reserved for a
durable inventory source and is not part of this guide's flow.

## 5. Read-only stance

- Every Spoolman request is `GET`. A test that sees any other method fails.
- The Connector never writes spool weight, filament, vendor or settings to
  Spoolman. Remaining weight is shown as reported; usage is calculated, not
  deducted upstream.
- Redirects are refused. Responses are not followed to other hosts.
- Credentials are sent only to the origin they were stored for.
- Spoolman data is display and planning evidence. It is not authorization for a
  print, and missing or stale data must not be read as "no spool".

## 6. Verify against the simulator

The simulator runs the pinned Spoolman image (see
[`infra/sim/docker-compose.yml`](../infra/sim/docker-compose.yml)) with its
fixture in [`infra/sim/spoolman/seed.json`](../infra/sim/spoolman/seed.json).
Use a port that no other service holds. The default is 7912; set
`SIM_SPOOLMAN_PORT` if that port is taken.

```sh
SIM_SPOOLMAN_PORT=7913 docker compose -f infra/sim/docker-compose.yml \
  -p openfarm-spoolman-guide --profile spoolman up -d spoolman

# Wait until this returns 200 (the first writes can take a while on a cold service).
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7913/api/v1/spool

# 1. Reader setup on an EMPTY service: checks empty inventory, seeds, archives one spool.
SPOOLMAN_SYNTHETIC_TEST_ORIGIN=http://127.0.0.1:7913 \
SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE=yes node scripts/test-spoolman-reader.ts

# 2. Seed is repeatable (idempotent).
SIM_SPOOLMAN_URL=http://127.0.0.1:7913 node packages/sim-tools/src/seed-cli.ts

# 3. Read-only qualification: page limits 1/2/4/200, weights, archive position.
SPOOLMAN_SYNTHETIC_TEST_ORIGIN=http://127.0.0.1:7913 \
SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE=yes node scripts/test-spoolman-node.ts

# 4. Live mirror: observed inventory, websocket invalidation, GET-only, stale on abort.
SPOOLMAN_SYNTHETIC_TEST_ORIGIN=http://127.0.0.1:7913 \
SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE=yes node scripts/test-spoolman-provider.ts

# Cleanup: removes only this compose project's container, network and volume.
docker compose -f infra/sim/docker-compose.yml -p openfarm-spoolman-guide \
  --profile spoolman down -v
```

Order matters. Step 1 refuses a non-empty inventory, so do not seed before it.
Steps 3 and 4 expect the fixture from steps 1 and 2. Step 4 writes one synthetic
spool and restores it in a `finally` block; never point it at real inventory.
The scripts refuse any origin that is not loopback HTTP and refuse to run
without `SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE=yes`.

Expected results: step 1 `"result":"passed"` with `empty:true`; step 2 prints
`{ vendors: 2, filaments: 4, spools: 6 }`; step 3 `"result":"passed"`; step 4
`"result":"passed"` with `providerMethods` all `GET`.

### 6.1 Receipt

Run on 2026-11-19 on a Linux amd64 host with Node v24.22.2, against a fresh
container of the pinned digest `sha256:1405c3db0661cabf45209701f95304cf65f7db3b0f262dc824d32a1694fdf5fa`
on port 7913 with its own compose project and volume. A separate Spoolman
service already held port 7912 and was not touched.

- Step 1 (`test-spoolman-reader.ts`): exit 0,
  `{"result":"passed","empty":true,"repeatableSeed":true,"vendors":2,"filaments":4,"spools":6,"pageLimits":[1,2,4,200],"archivedIncluded":true,"ascendingIdsAcrossPages":true}`.
- Step 2 (`seed-cli.ts`): `{ vendors: 2, filaments: 4, spools: 6 }`, exit 0.
- Step 3 (`test-spoolman-node.ts`): exit 0,
  `{"result":"passed","runtime":"v24.22.2","spools":6,"pageLimits":[1,2,4,200],"archivedIncluded":true}`.
- Step 4 (`test-spoolman-provider.ts`): exit 0,
  `{"result":"passed","runtime":"v24.22.2","providerMethods":["GET"],"reads":2,"invalidateMs":683,"refreshMs":13029,"staleOnClose":true}`.
  The provider reached `observed`, marked the snapshot `stale` within 0.7 s of
  the synthetic PATCH and refreshed within 13 s.

Operator notes from this run:

- The first write on a cold simulator took about 22 seconds. `seed-cli` gives
  each request five seconds and retries only the first pass, so a cold service
  needed two or three runs of step 2 before it succeeded. Wait for the readiness
  check in the sequence above before seeding.
- Seeding before step 1 makes step 1 refuse the non-empty inventory. Recreate
  the compose project with `down -v` and start again.

This receipt covers the simulator only. It does not establish production
Spoolman compatibility, the WebSocket path under network partition or heartbeat
timeout (covered by simulated-transport unit tests), or hardware acceptance.

## 7. Troubleshooting

| Symptom                                  | Likely cause and fix                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `spoolman-unreachable` on setup          | Origin wrong, service down, or the Connector cannot reach it. Check the origin and the network path.   |
| `spoolman-unauthorized`                  | Credentials missing or wrong. A credential bound to another origin is never sent.                      |
| `not-available` on commit                | The Connector has no runtime configuration with a printer yet.                                         |
| Inventory always `stale`                 | WebSocket cannot connect, or reads keep failing. Check the origin and reverse-proxy WebSocket support. |
| Spool shows no grams for usage           | Filament diameter or density is missing in Spoolman, so grams are omitted by design.                   |
| Active spool missing for a tool          | Moonraker reports no active spool and no manual assignment exists, or the ID is not in the inventory.  |
| Duplicate or missing spools after a seed | Run the seed one at a time; the seed refuses ambiguous markers rather than adding more.                |
