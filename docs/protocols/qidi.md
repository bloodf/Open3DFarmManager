# Qidi LAN protocol

All models remain unqualified pending owner hardware checks. The adapter targets
an operator-provisioned local Moonraker origin. A successful probe establishes
Moonraker reachability and reports the server version and Klippy connection
state. Identify the model and vendor firmware from the printer's local UI.
The FullFarmManager review and FDM catalog list Qidi model references. The Moonraker fixture is synthetic and does not identify a physical model or vendor firmware; the Max4 version below comes from a third-party mirror, not a vendor release.

## Model evidence

| Model     | Firmware evidence                                                                                                                                                               | LAN coverage and gaps                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 Pro    | [4.4.24 release](https://github.com/QIDITECH/QIDI_Q1_Pro/releases) and [vendor firmware repository](https://github.com/QIDITECH/QIDI_Q1_Pro)                                    | Forked Moonraker and Fluidd. The release adds Fluidd account management. Verify the configured endpoint and local credential type, snapshot and history on hardware.          |
| Plus4     | [1.7.1 release](https://github.com/QIDITECH/QIDI_PLUS4/releases)                                                                                                                | Forked Moonraker and Fluidd. Release notes describe resume changes and material-wrapping messages. QIDI Box, camera, chamber and vendor alert fields need dedicated evidence. |
| Q2        | [1.1.1 release](https://github.com/QIDITECH/QIDI_Q2/releases) and [vendor firmware repository](https://github.com/QIDITECH/QIDI_Q2)                                             | Forked Moonraker and Fluidd. Confirm endpoint, auth, camera, chamber and Box behavior for the installed firmware.                                                             |
| Max4      | [Vendor firmware repository](https://github.com/QIDITECH/QIDI_MAX4) and [01.01.07.01 firmware mirror evidence](https://github.com/thelegendtubaguy/Qidi-Max4-Defaults/releases) | Forked Moonraker and Fluidd. The mirror identifies a vendor package version. Endpoint, auth, camera, chamber and Box behavior still require checks.                           |
| X-Max 3   | [4.3.15 release](https://github.com/QIDITECH/QIDI_MAX3/releases) and [vendor firmware repository](https://github.com/QIDITECH/QIDI_MAX3)                                        | Vendor documents Fluidd on 10088 and forked Moonraker. Camera, history and additional outputs need an on-device check.                                                        |
| X-Plus 3  | [Vendor firmware repository and releases](https://github.com/QIDITECH/QIDI_PLUS3)                                                                                               | Vendor documents Fluidd on 10088 and forked Moonraker. Capture the installed firmware, auth mode, camera and history before qualifying.                                       |
| X-Smart 3 | [4.1.13 firmware documentation](https://github.com/QIDITECH/QIDI_SMART3)                                                                                                        | Vendor documents Fluidd on 10088 and forked Moonraker. Confirm the installed configuration and optional endpoints.                                                            |

Older Qidi models and unlisted firmware have no qualification evidence here. A
Fluidd port describes its front end. Configure an origin that exposes the
Moonraker HTTP routes. The adapter does no scanning, default-port guessing,
vendor login or firmware matching.

## Adapter contract

- Probes `GET /server/info`. Reads explicit trusted-LAN access, an existing
  local API key or a supplied bearer token. Token issuance and refresh are
  outside this adapter. Plain HTTP carries credentials over the LAN in clear
  text. [Moonraker authorization API](https://moonraker.readthedocs.io/en/latest/external_api/authorization/)
- Reads `/printer/objects/query` for webhooks, print stats, virtual SD progress,
  extruder, bed and the standard part fan. Exposes device-provided values
  including Klippy messages, temperature/target in Celsius, fan speed as a
  fraction and `print_stats.filament_used` in millimeters when reported. Keep
  missing data unknown. Spool identity, Box slots, material type, remaining
  stock, chamber and named fans need separate evidence. Vendor fault codes and
  alerts are unverified. [Klipper status reference](https://www.klipper3d.org/Status_Reference.html)
- Reads the newest history page, up to 50 jobs, if the history component
  exists. Returns device records, including reported consumption. No accounting
  debits, pagination or inferred usage. [Moonraker history API](https://moonraker.readthedocs.io/en/latest/external_api/history/)
- Reads an explicitly configured same-origin JPEG snapshot with bounded
  response size and timeout. Direct vendor video, automatic camera discovery
  and browser media wiring remain pending.
- Reuses Connector Moonraker multipart G-code upload to the `gcodes` root with
  trusted-LAN access or an API key. The existing helper accepts HTTP success
  status and does not parse the reply. Bearer upload is unavailable. Upload is
  a single request and does not request a print start.
  [Moonraker file API](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/)
- Job controls and heater/fan writes remain pending. Qualify the existing
  Moonraker driver against each firmware before advertising actions. Preserve
  local binding, signed scope, fresh observations, file and bed-clear checks,
  and the no-retry rule for uncertain dispatch. Plus4's firmware notes alone
  cannot establish that all variants accept the same controls.

The loopback fixtures are original, synthetic records derived from the public
API contract. They exercise the actual HTTP transport and cannot qualify a
firmware or physical camera. No upstream source or firmware blobs are copied
and there are no new dependencies.

## Integration follow-up

1. Add local Qidi provisioning and endpoint validation in
   `packages/connector/src/config/` and
   `packages/connector/src/runtime/configuration-discovery.ts`. Bind the
   provisioned endpoint before selecting the driver.
2. Wire read collection, snapshot relay and eligible file targets through the
   Connector runtime, including `packages/connector/src/runtime/file-targets.ts`.
   Reuse `packages/connector/src/runtime/pause-driver-router.ts` only after
   firmware-specific control fixtures and owner hardware checks.
3. Add sourced model rows to `docs/fullfarmmanager/catalog-fdm.md` and model
   profiles under `packages/connector/src/machine-profile/`. Carry separate
   evidence grades for spec, protocol fixture and hardware.
4. Update `apps/farm/app/pages/compatibilidade.vue` and printer setup/detail
   surfaces in pt-BR. Show unavailable capabilities and enable controls only
   when the Connector advertises qualified support and the session has
   authority.

## Read-only collection activation

The brand collector accepts a `qidi` binding with `printerKey`, a canonical
HTTP(S) `origin`, an explicit `simulated` boolean, and `expect` containing the
required Moonraker version. Optional `expect.model` and `expect.firmware`
are operator-supplied metadata and do not gate collection. Match the origin exactly against the Connector's local
allowlist. Use a private, link-local IPv4 or loopback IP literal and the
operator-confirmed Moonraker port. The shared loader must reject duplicate
printer keys and duplicate endpoint ownership across all configured drivers.

Use `auth.kind` of `trusted-lan`, `api-key`, or `bearer`. The latter two
require an absolute `credentialFile` path to private JSON containing
`origin` and `secret`. The credential origin must match the binding exactly.
The collector reloads credentials on each poll and follows no redirects.

The shared runtime must provision and dispatch the binding, register the
`qidi` field timestamps with the snapshot provider, and route withdrawal to
the provider using the printer key and epoch. Wire
`qidi-simulated` and `qidi-unqualified` into the shared status schema and
display them in the UI. The polling interface takes the local allowlist,
a lifecycle abort signal and a request timeout from 1 through 3000 ms.
Each poll requires the expected Moonraker version, ready Klippy, a known
print state, and reported progress. Recovery publishes a new epoch.
The probe verifies the Moonraker version and Klippy readiness. Snapshots
carry a Qidi vendor label from the configured driver and omit device model
and vendor firmware. The live snapshot advertises an empty controls list.

For hardware qualification, verify the installed model and vendor firmware
on the printer, confirm its local endpoint and authentication mode, and
capture live state and withdrawal/recovery evidence for that exact pairing.
Camera, history, upload and controls require separate integration and evidence.
