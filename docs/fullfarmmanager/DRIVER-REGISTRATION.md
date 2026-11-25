# Driver registration contract (candidate)

Status: proposal, 2026-11-22. The Connector v8 runtime implements the [PrusaLink read-only status slice](../protocols/prusa.md#connector-v8-read-only-collection). It covers Prusa (PrusaLink and Connect Local), Qidi, Flashforge, Phrozen and Anycubic Photon resin. It reuses the registered SDCP and Formlabs read-only collection as the pattern. Stage 1 acceptance uses simulator evidence. Hardware qualification is required for the hardware grade and for stage 2 commands.

## What the code does today

| Family                 | Adapter                                                   | Identity source                                                                                                                       | Credential                                                                                       | Writes in adapter                                                                                                                                               | Registered in runtime                                                                                                                   |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| PrusaLink              | `packages/connector/src/prusa/index.ts` `createPrusaLink` | `/api/version` (API `1.x` or `2.x`) and `/api/v1/info`                                                                                | `X-Api-Key`                                                                                      | upload, start, pause/resume/cancel by job id; each send passes a `Guard.beforeSend()` and uses one fresh connection                                             | no                                                                                                                                      |
| Prusa Connect Local    | same file, `createPrusaConnectLocal`                      | device list plus `id` echo check                                                                                                      | Bearer token                                                                                     | none                                                                                                                                                            | no                                                                                                                                      |
| Qidi                   | `packages/connector/src/qidi/index.ts`                    | none from the wire: Moonraker `/server/info` proves reachability only; model and firmware must come from local provisioning           | optional `X-Api-Key` or Bearer                                                                   | G-code upload only (no start)                                                                                                                                   | no                                                                                                                                      |
| Flashforge             | `packages/connector/src/flashforge/index.ts`              | UDP 48899 reply (PID, serial), then `/detail` PID and firmware allowlist (5M/5M Pro `3.2.7`, `5.1.8`; AD5X `1.1.7`, `1.2.1`, `3.1.0`) | serial number and check code in every POST                                                       | `execute()` covers pause/resume/cancel, start, upload, setpoints and fan. It rereads status and calls an `authorize(observation)` callback. AD5X writes refused | no                                                                                                                                      |
| Phrozen                | `packages/connector/src/phrozen/index.ts`                 | UDP `M99999` from the configured IPv4; exact `Sonic Mighty Revo 14K`, firmware `V138`/`V153`, protocol `V3.0.0`, mainboard id         | none                                                                                             | none (command 0 status only)                                                                                                                                    | no                                                                                                                                      |
| Anycubic Photon P1 Max | `packages/connector/src/anycubic-resin/index.ts`          | `GET /info` on 18910; `modelId 132`, `Anycubic Photon P1 Max`                                                                         | derived at runtime: `/info` token plus one signed `POST /ctrl` returns MQTT credentials for 8883 | none                                                                                                                                                            | no                                                                                                                                      |
| Elegoo SDCP            | `sdcp/index.ts`, `runtime/sdcp-collection.ts`             | rediscovered before each session and compared with bound `mainboardId` and model; firmware taken from discovery                       | none                                                                                             | `command()` returns `unsupported`                                                                                                                               | yes: collector `version: 6`, assignment `backend: 'sdcp'`                                                                               |
| Formlabs               | `formlabs/index.ts`, `runtime/formlabs-collection.ts`     | PreForm `/devices/` entry by `deviceId`; Form 4/4L only                                                                               | none                                                                                             | `command()` returns `unsupported`                                                                                                                               | yes: collector `version: 7`, `backend: 'formlabs'`; live host-reported status text with a retrieval timestamp and unknown printer state |

Structural constraint: `config/runtime.ts` accepts collector versions 1–7. Each version allows the Moonraker base plus **one** vendor section (v2 KobraLink, v3 Bambu, v4 Creality, v5 Anycubic FDM, v6 SDCP, v7 Formlabs). Each parser falls back to the previous version's parser. So today one Connector cannot hold both an SDCP and a Formlabs printer, and adding five families as v8–v12 would make this worse. The contract below fixes that once.

## Candidate contract

### 1. Collector configuration v8

A single `drivers` array replaces the per-family sections for the read-only families. The Moonraker `printers`, `allowedOrigins`, `limits` and `spoolman` fields from v1 are unchanged.

```ts
// packages/connector/src/config/drivers.ts (new)
const Key = z.string().min(1).max(128)
const SecretFile = z.string().min(1).max(4096) // absolute, 0600, read with readPrivateJsonFile rules
const Base = { printerKey: Key }

export const DriverBinding = z.discriminatedUnion('family', [
  z.strictObject({
    ...Base,
    family: z.literal('sdcp'),
    host: z.ipv4(),
    mainboardId: Id64,
    model: SdcpModel,
  }), // = today's SdcpBinding
  z.strictObject({
    ...Base,
    family: z.literal('formlabs'),
    host: LocalHost,
    port: Port,
    deviceId: Key,
  }), // = today's FormlabsBinding
  z.strictObject({
    ...Base,
    family: z.literal('prusa-link'),
    origin: CanonicalOrigin,
    apiKeyFile: SecretFile,
    expect: z.strictObject({ serial: Key, printerType: Key }),
  }),
  z.strictObject({
    ...Base,
    family: z.literal('prusa-connect-local'),
    origin: CanonicalOrigin,
    tokenFile: SecretFile,
    deviceId: Key,
  }),
  z.strictObject({
    ...Base,
    family: z.literal('qidi'),
    origin: CanonicalOrigin,
    authFile: SecretFile.optional(),
    snapshotPath: z.string().startsWith('/').max(512).optional(),
    declared: z.strictObject({ model: QidiModel, firmware: Key }),
  }), // operator-declared, never inferred
  z.strictObject({
    ...Base,
    family: z.literal('flashforge'),
    host: z.ipv4(),
    serialNumber: Cred128,
    checkCodeFile: SecretFile,
    model: z.enum(['Adventurer 5M', 'Adventurer 5M Pro', 'AD5X']),
  }),
  z.strictObject({
    ...Base,
    family: z.literal('phrozen'),
    host: z.ipv4(),
    mainboardId: Hex64,
    model: z.literal('Sonic Mighty Revo 14K'),
  }),
  z.strictObject({
    ...Base,
    family: z.literal('anycubic-resin'),
    host: z.ip(),
    serial: Key,
    modelId: z.literal('132'),
  }),
])

const CollectorV8 = LegacyV1Base.extend({
  version: z.literal(8),
  allowedOrigins: z.array(Origin).max(16),
  printers: z.array(MoonrakerPrinter).max(16),
  drivers: z.array(DriverBinding).min(1).max(16),
})
```

Invariants checked by `parseCollectorConfig` (same style as `config/sdcp.ts`):

- The total of `printers.length` and `drivers.length` is at most 16.
- `printerKey` is unique across `printers` and `drivers`.
- Each family has a physical target key that must be unique: SDCP `host` and `mainboardId`; Formlabs `[host, port, deviceId]`; Prusa and Qidi canonical `origin`; Flashforge `host` and `serialNumber`; Phrozen `host` and `mainboardId`; Anycubic resin `host` and `serial`.
- A Qidi `origin` must not appear in `allowedOrigins`. Qidi runs a Moonraker fork, and the generic Moonraker registry would give it Klipper command mappings that nobody has qualified.
- Bambu, Creality, Anycubic FDM and KobraLink stay on v2–v5 for now. v8 rejects their keys. Moving them is a separate change, listed under gaps.

### 2. Runtime assignment

`config/runtime.ts` adds `8` to `Runtime.version`. For `collection.version === 8` it maps each assignment by `printer_key` to exactly one `drivers` entry, and the assignment's `backend` must equal the entry's `family`. The `SdcpAssignment` schema in `control/printer-binding.ts` widens its enum to:

```ts
backend: z.enum([
  'sdcp',
  'formlabs',
  'prusa-link',
  'prusa-connect-local',
  'qidi',
  'flashforge',
  'phrozen',
  'anycubic-resin',
])
```

Every new family provisions through `provisionReadonlyPrinter`. That handle has no command mapping, so `pause.control.assignmentIds` that names one fails at startup ("Backend does not support pause control"), as it does today. The completeness check becomes `assignments.length === printers.length + drivers.length`, followed by an exact-one-match loop over `drivers`, as v6 and v7 already do.

### 3. Config migration

- Collector versions 1–7 keep parsing as they do today. v8 is opt-in. Nothing rewrites a v6 or v7 file implicitly.
- Add a pure function `upgradeCollectorToV8(v6 | v7) → v8`. It maps `sdcp.printers[i]` to `{family: 'sdcp', ...}` and `formlabs.printers[i]` to `{family: 'formlabs', ...}`, copies the base fields, and sets `version: 8` in both `collection` and the runtime root. The function rejects v2–v5 input.
- Run the upgrade only through an explicit Connector CLI step. Reuse the write-temp, copy-to-`.bak` with `COPYFILE_EXCL`, then rename sequence from `config/version.ts`. Keep `readAgentRuntimeConfig` on `persist = false`. Bump `CURRENT_CONFIG_SCHEMA_VERSION` only if the root shape changes, which this proposal avoids.
- Downgrade means restoring the `.bak` file. A v8 file on an older Connector fails with "newer than supported", or with a `Runtime.version` parse error, before any task starts. It is never partially loaded.

### 4. Credential boundaries

- The config holds only file paths for secrets (`apiKeyFile`, `tokenFile`, `authFile`, `checkCodeFile`). These files are read with the private-file rules in `config/local.ts`: regular file, `nlink === 1`, owner-only mode. A secret never sits inline in the collector JSON, a farm-protocol frame, telemetry, an assignment or a log. `serialNumber` is an identifier rather than a secret, but Flashforge resends it on every POST. Treat it as identity and never log it in full.
- Anycubic resin credentials are derived per session and exist only in memory, as `anycubic-resin.md` requires. Exchanges are serialized per printer because `/info` rotates the token. There is no credential file and no persistence.
- Phrozen, SDCP and Formlabs have no credentials. Registering one is authorization by local provisioning only.
- Any provisioned secret stays bound to the target in the same `drivers` entry. Rebinding a target requires a new entry and a new assignment. The operator provisions credential files locally on the Connector. Farm setup manages nonsecret assignment metadata only. The server receives a configuration receipt, with no secret, secret path, or secret-derived digest.

### 5. Model and firmware identity

The table records identity fields and their sources. The PrusaLink row describes the implemented v8 observation.

| Family              | `model` from                                                    | `firmware` from                       | `identitySource`    | Mismatch behaviour                                  |
| ------------------- | --------------------------------------------------------------- | ------------------------------------- | ------------------- | --------------------------------------------------- |
| sdcp                | discovery `MachineName`, checked against binding                | discovery `FirmwareVersion`           | `wire`              | withdraw epoch, reason `identity`                   |
| formlabs            | PreForm `product_name`                                          | PreForm `firmware_version` (optional) | `host`              | withdraw; unsupported model is never published      |
| prusa-link          | Configured printer type after wire identity matches the binding | Omitted                               | Omitted             | Withdraw observation                                |
| prusa-connect-local | device detail                                                   | device detail                         | `host`              | withdraw on `id` mismatch (already enforced)        |
| qidi                | `declared.model`                                                | `declared.firmware`                   | `declared`          | the UI must show "declarado pelo operador"          |
| flashforge          | UDP PID, and `/detail` PID on every read                        | `/detail` `firmwareVersion` allowlist | `wire`              | withdraw; model change versus binding is a mismatch |
| phrozen             | UDP identity, exact model                                       | `V138`/`V153` allowlist               | `wire`              | adapter refuses; withdraw                           |
| anycubic-resin      | `/info` `modelId`/`modelName`, checked against `serial`         | unknown (the capture has no firmware) | `wire` (model only) | `firmware: null`, never guessed                     |

Identity is re-proven at the start of every collection session, following `sdcp-collection.ts`, not only at registration.

### 6. Advertised simulated status

The registration advertises a capability vector and never claims more than its evidence supports:

```ts
type Grade = 'hardware' | 'documented' | 'simulated' | 'unknown' | 'unsupported' // = CatalogCapability
type Advertised = Readonly<{
  status: Grade
  camera: Grade
  files: Grade
  control: Grade
  materials: Grade
  evidence: Readonly<
    Partial<
      Record<
        'status' | 'camera' | 'files' | 'control' | 'materials',
        { file: string; test: string }
      >
    >
  > // = ControlAreaEvidence
}>
```

- A capability can be `simulated` only when the map names an in-repo simulator test that proves it. Without that test, the grade is `unknown`.
- The Connector never emits `hardware`. That grade comes only from the farm catalog after owner qualification.
- `controls: []` on the observation stays authoritative. A capability graded `simulated` but absent from `controls` is shown and never enabled.
- Initial vector: status `simulated` for PrusaLink, Qidi, Flashforge and Phrozen where the simulator evidence covers the claimed status. Prusa Connect Local and Formlabs printer status are `unknown` until a printer observation time is evidenced. Formlabs carries live host-reported text separately. Adapter fixtures prove protocol behavior. Registration and screen behavior require the journeys below. Anycubic-resin status is `unsupported`, because there is no broker session. Everything else is `unknown` or `unsupported`.

### 7. Telemetry staleness

Every collection loop follows the `createSdcpCollection` and `createFormlabsCollection` shape:

- It has an `epoch` counter. Each `onUnavailable(epoch++, reason)` withdraws the previous epoch. Reasons come from a closed set: `offline`, `stale`, `identity`, `unauthorized`, `unsupported`, `malformed`, `observation-time-unknown`.
- `observedAt` must be printer time or the receipt time of a synchronous read served by the printer itself. PrusaLink, Qidi/Moonraker, Flashforge `/detail`, Phrozen and SDCP command 0 qualify. Prusa Connect Local and PreForm are hosts that cache printer state. They need a printer-side timestamp to publish fresh printer telemetry. Formlabs publishes a separately labeled host reading with a retrieval timestamp.
- `staleAfterMs` defaults to 30 000. When the snapshot is older than that, or `now - observedAt < 0`, the loop withdraws with `stale` and reconnects after `retryMs`. A stale value is never re-emitted with a new `observedAt`.
- Field freshness uses `fieldObservedAtMonoMs` under a family key, such as `{ 'prusa-link': {...} }` or `{ flashforge: {...} }`. Generalize the union in `runtime/farm-snapshot-provider.ts` to `Readonly<{ [family]: Partial<Record<keyof PrinterState, number>> }>` keyed by `DriverBinding['family']` rather than adding another union arm per family.

### 8. Issuer-signed command paths

There are none in stage 1. Each new family's handle is read-only and its `command()` returns `{ ok: false, reason: 'unsupported' }`.

In stage 2 a family enables commands only when hardware evidence and the owner's decision allow it. Prusa-link pause/resume/cancel and Flashforge 5M/5M Pro pause/resume/cancel are the candidates. The path is the existing one, with no new channel:

1. Browser: a `SignedCommandV2` over WebRTC only, with no TURN and no HTTP fallback. API: an `ApiEnvelopeV1` signed by `API_ENVELOPE_ISSUER` within the owner-granted scope, delivered through the authenticated inbox.
2. The Connector verifies signature, TTL, clock skew and scope, then routes through `runtime/pause-driver-router.ts` (pause family) or `runtime/api-command.ts`.
3. The driver gets a fresh observation of the same epoch and checks it: Prusa job id and state, Flashforge `status` and `filename`. It then rechecks authority inside the adapter hook (Prusa `Guard.beforeSend()`, Flashforge `authorize(observation)`) immediately before the single write.
4. `control/command-journal.ts` records the attempt before the send and the outcome after it.

Families that hold no signed handle never reach step 3. Bindings that might become writable later need a separate `provisionWritable<Family>Printer`, as Bambu, Creality and Anycubic FDM have. The read-only enum must not grow a command mapping.

### 9. Uncertain-command reconciliation without retry

- One journal row allows one send. If a timeout, socket error or abort happens after `beforeSend()` returns true, the outcome is `outcome-unknown` (reason `rpc-unknown` or `deadline`). If the printer acknowledged the send but the effect is not yet observed, the reason is `state-unconfirmed`.
- Reconciliation reads state without sending a command. Require a fresh observation newer than the send, bound to the same identity and epoch. Pause and resume require the same job and the expected state. Cancel requires an explicit cancellation observation correlated with the same job. Idle, natural completion, or a replacement job alone leaves the result unknown. Flashforge filename alone cannot distinguish successive jobs with the same name.
- A correlated observation records that the expected effect was observed. An unresolved attempt keeps the printer on hold across restarts. Release requires explicit operator acknowledgement through an authorized reconciliation action. Acknowledgement leaves the recorded outcome unknown. Show “Resultado desconhecido” and the hold. Any later command requires a fresh operator intent and a new signed envelope.
- An epoch withdrawal (identity change, offline) never confirms anything. The row stays unknown.

## Simulator journey per family

All journeys run on loopback simulators under `tests/journey/`. They never contact physical printers. Each journey adds its vendor to `VendorName` in `tests/journey/harness-vendors.ts`.

| Family              | Simulator                                    | Journey (happy path → faults)                                                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prusa-link          | `sim-tools/src/prusa-simulator.ts` (handler) | Register origin and key file → version `1.x` and info match `expect` → status appears as "Simulado" → wrong key gives 401 and `unauthorized` → `expect.serial` mismatch gives `identity` → handler stops replying and the stale withdrawal hides values. Stage 2: drop the pause reply after send → one PUT, `outcome-unknown`, no second request. |
| prusa-connect-local | same simulator, Connect routes               | Register token file and device id → device appears → `id` echo mismatch withdraws. Status stays `observation-time-unknown` until a printer timestamp is evidenced.                                                                                                                                                                                 |
| qidi                | `qidi-simulator.ts` (`setFault`)             | Register origin with declared model and firmware → status with a declared-identity label → `timeout` gives stale → recovery opens a new epoch → `malformed` withdraws. Assert that no Klipper controls are advertised.                                                                                                                             |
| flashforge          | `flashforge-simulator.ts`                    | UDP discovery returns PID and serial → registration → 5M status. A firmware outside the allowlist is refused. An AD5X fixture shows slots read-only. A serial mismatch withdraws.                                                                                                                                                                  |
| phrozen             | `phrozen-simulator.ts` (faults)              | Revo 14K V153 registers → status appears → `wrong-board`, `denied`, `malformed`, `disconnect` and `timeout` each withdraw with their reason.                                                                                                                                                                                                       |
| sdcp                | `sdcp-simulator.ts`                          | Existing v6 registration migrated to v8 → same status → mainboard mismatch withdraws. Coordinate the shared harness with openfarm-farm.                                                                                                                                                                                                            |
| formlabs            | `formlabs-simulator.ts`                      | v7 migrated to v8 → same PreForm status text → host outage withdraws the live reading → recovery shows new host text.                                                                                                                                                                                                                              |
| anycubic-resin      | `anycubic-resin-simulator.ts`                | `/info` identity → credential negotiation in memory → the broker is refused → registration visible with status `unsupported`. Assert that no credential is written to disk or sent in telemetry.                                                                                                                                                   |

A mixed journey uses one v8 file with SDCP, Formlabs, Qidi and Phrozen to prove independent collection and withdrawal. Main has protocol fixtures. The current v7 Formlabs path has a browser journey in `tests/journey/formlabs.spec.ts`.

## Ownership

**Mac units, Connector side.** Each family can land independently once the v8 skeleton is in place.

- Skeleton, first and serial: `packages/connector/src/config/drivers.ts`, the v8 branch in `config/runtime.ts`, the backend enum in `control/printer-binding.ts`, the generic family key in `runtime/farm-snapshot-provider.ts`, and `upgradeCollectorToV8` with its CLI step. One Mac unit owns these shared files and integrates each family’s wiring in `runtime/collect.ts`.
- Then one unit per family, in parallel: `packages/connector/src/runtime/<family>-collection.ts`, the `packages/sim-tools/src/<family>-simulator.ts` fault extensions, and the `tests/node/<family>-*.test.ts` collection tests.
- Stage-2 command wiring for Prusa and Flashforge lives in `runtime/pause-driver-router.ts`, `runtime/api-command.ts` and `control/command-journal.ts`. It waits for hardware evidence and owner approval.

**openfarm-farm**, the farm app and shared wire schema:

- `packages/farm-protocol/src/configuration-discovery.ts`: extend `DiscoveryPrinter.vendor` with the new families. Wire schemas need server agreement.
- Server-side assignment `backend` enum and setup endpoints that issue nonsecret assignment metadata through the configuration channel. The Connector owns the local driver bindings and credential paths.
- `apps/farm/app/components/printer-setup/`: add `PrusaFields`, `QidiFields`, `FlashforgeFields`, `PhrozenFields`, `FormlabsFields` and `AnycubicResinFields` (pt-BR, show local credential provisioning instructions). SDCP also needs a fields component here.
- `apps/farm/app/utils/compatibility/` and `pages/compatibilidade.vue`: catalog rows and grade rendering.
- `apps/farm/server/utils/resin-ledger/` and `components/resin/`: ledger changes.
- `tests/journey/*.spec.ts` that drive the farm UI. The harness vendor entries are shared and depend on Connector simulators.

## Exact gaps

### Catalog (`apps/farm/app/utils/compatibility/fleet-catalog.ts`, `docs/fullfarmmanager/catalog-fdm.md`)

1. No Prusa, Qidi or Flashforge rows exist. The catalog brands are Anycubic, Bambu Lab, Creality, Elegoo, Formlabs, Phrozen and Snapmaker, and `catalog-fdm.md` has zero mentions of the three. The REVIEW matrix lists them, but no `FleetModel` row backs them.
2. `Sonic Mighty Revo 14K` has `protocol: 'Wire protocol/ports unverified'` and `protocolGrade: 'unverified'`, although an SDCP V3.0.0 adapter exists with a V153 synthetic fixture and firmware allowlist. It should be `spec-derived` for status only, with a note that V138 has no positive fixture.
3. `Photon P1 Max` says "wire protocol/ports unverified", but the adapter documents 18910 HTTP and 8883 MQTT from a public capture. It should be `spec-derived` for the handshake only, with status `unsupported`.
4. `Form 4` and `Form 4L` have `capabilities: []`. They need a status row graded `unknown` with the reason "sem horário de observação da impressora".
5. The existing catalog rows for Sonic Mighty Revo 14K, Photon P1 Max, Form 4 and Form 4L have no per-capability entries or evidence for the read-only behavior described in §6.
6. `DiscoveryPrinter.vendor` lacks every new family, so background discovery cannot surface them.

### Resin ledger (`apps/farm/server/utils/resin-ledger/`)

1. `provenance: 'reported'` exists but nothing produces it. No Connector code or farm-protocol frame emits resin readings, and no adapter reads resin level or volume. SDCP status has none. Phrozen raw status has release-film wear and UV LED temperature, but no evidence ties wear to `film.layers`, so the mapping must not be invented. Formlabs material fields are a listed gap. Anycubic resin has no status at all.
2. The ledger is keyed by `printerKey` only. Rebinding a key to a different mainboard, serial or device id carries the vat and film history over. The entries need the bound identity (`family` and target key) recorded, and must refuse to merge across identities.
3. `ResinLedgerPanel` renders on every printer detail page (`v-if="row && ready?.scope?.farmId"`), FDM included. It needs a resin-kind gate taken from the registered identity mapped to a catalog `kind`.
4. No estimated-volume kind exists. If job volume estimates are ever reported, they need a distinct kind or provenance (`estimated`) so they are not shown as measurements.

### Screens (`apps/farm/app/`)

1. `components/printer-setup/` has fields only for Anycubic, Bambu, Creality, Kobra X and Moonraker. SDCP and Formlabs are registered in the runtime but have no setup form. None of the five new families has one.
2. `pages/impressoras/[printerKey].vue` has no way to show `identitySource: 'declared'` (Qidi) or `firmware: null` (Anycubic resin) as distinct from a verified value.
3. Farm and painel views need the closed reason set from §7. Show `observation-time-unknown` and `stale` as text, distinct from offline.
4. The capability grade needs a visible "Simulado" badge next to any `simulated` capability, and disabled controls with the reason when a capability is not in `controls`.
5. Command results need the uncertain state from §9: "resultado desconhecido", a hold banner and operator acknowledgement, with no retry button.
