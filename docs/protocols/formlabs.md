# Formlabs PreForm Local API

The Connector adapter talks to a configured, trusted PreForm Server origin.
The default port in the vendor quickstart is 44388. Keep the service on
loopback where possible, or on a restricted operator-controlled network.
The adapter sends no credentials. The vendor authentication endpoints set a
process-wide Dashboard session for cloud-backed operations. Local listing and
discovery do not require that session. Use a dedicated local instance without
a Dashboard login. Responses marked remote or virtual are excluded.

- [PreForm quickstart](https://developer.formlabs.com/getting-started/quickstart/)
- [Device contract, v1.0.0-alpha.1](https://developer.formlabs.com/api-reference/devices/)
- [Authentication](https://developer.formlabs.com/api-reference/authentication/)
- [Firmware releases](https://formlabs.com/support/Firmware-Release-Notes/)
- [PreForm releases](https://formlabs.com/support/PreForm-Release-Notes/)

| Model         | Vendor firmware listing | Adapter evidence                                                                                                                             |
| ------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Form 4        | 1.17.1                  | Documented Form 4 family status schema. Synthetic fixture. Owner hardware qualification pending.                                             |
| Form 4L       | 1.17.1                  | Same documented family schema. Synthetic fixture. Owner hardware qualification pending.                                                      |
| Form Studio 1 | 1.0.0                   | Vendor lists PreForm support. The device reference provides no Studio 1-specific status schema. Adapter excludes the model pending evidence. |

The firmware versions identify the release listings consulted. They establish
neither a minimum Local API version nor observed firmware behavior. The
adapter reports the firmware string from the host.

## Capabilities

| Capability                 | Form 4 and Form 4L                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery                  | POST /v1/device/discover/ with a two-second vendor wait. GET /v1/device/list/ reads known devices. PreForm performs network discovery.                                                                                          |
| State                      | Fresh device list per read. Reports vendor status text verbatim and vendor estimated remaining milliseconds. A missing device yields null. HTTP and parse failures propagate. No machine-state inference from localized status. |
| Materials                  | Tank ID and material code when present. Cartridge IDs and material codes as reported.                                                                                                                                           |
| Consumption                | Vendor-estimated cumulative cartridge dispensing and original cartridge capacity in mL. Per-job consumption and current tank volume are unavailable.                                                                            |
| Camera, temperatures, fans | The local device schema exposes none for these models. Form Mobile firmware features use a separate internet workflow.                                                                                                          |
| Upload and job controls    | The vendor scene endpoint can slice and queue or start a job. Dispatch is outside this read-only slice. Pause, resume and cancel lack documented local device endpoints.                                                        |
| Alerts and history         | Human-readable status only. Structured alerts and print history lack documented local device endpoints. Dashboard history belongs to the Web API.                                                                               |

The adapter issues only listing and discovery requests. It does not follow
redirects, cache old readings, send signed commands, or retry failed requests.
Original synthetic fixtures exercise the documented schema through a temporary
loopback HTTP server. No vendor code or SDK dependency is included.

- [Scene submission](https://developer.formlabs.com/api-reference/scenes/)
- [API overview and Dashboard history](https://developer.formlabs.com/)

## Integration follow-up

- Add explicit PreForm origin and serial binding in
  `packages/connector/src/config/` and `packages/connector/src/provisioning/`.
  Register collection in `packages/connector/src/runtime/` and map freshness,
  absence and host failures at the shared snapshot boundary.
- Add evidence grades in `packages/connector/src/machine-profile/` and update
  `docs/fullfarmmanager/catalog-resin.md` after owner hardware verification.
- Update `apps/farm/app/pages/compatibilidade.vue` and the printer UI under
  `apps/farm/app/pages/impressoras/`. Expose observed read-only fields and
  distinguish missing devices from an unavailable PreForm host.
- Before introducing scene submission, wire Connector authorization, printer
  binding and dispatch admission. Poll an accepted asynchronous operation by
  its documented operation ID. Reconcile uncertain outcomes without
  resubmitting. Leave camera and command UI disabled until qualified.
