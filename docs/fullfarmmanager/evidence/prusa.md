# Prusa: PrusaLink evidence and gaps

Reviewed 2026-11-25. Source reading and loopback simulators only. No physical printer was contacted. **Every catalog row stays unqualified.** See also the [protocol notes](../../protocols/prusa.md).

## Sources

| ID    | Repository and commit                                                                                                                               | Paths                                                                                                                                                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec  | [`prusa3d/Prusa-Link-Web@a67f306b`](https://github.com/prusa3d/Prusa-Link-Web/tree/a67f306bc878009be0e27864a01a1837e5c4cf06)                        | `spec/openapi.yaml`                                                                                                                                                                                                                                                                                                                                     |
| Buddy | [`prusa3d/Prusa-Firmware-Buddy@b1043d68`](https://github.com/prusa3d/Prusa-Firmware-Buddy/tree/b1043d68be188ad27ea72a14e160140e30e589f0) (`v8.0.2`) | `include/common/printer_model_data.hpp`, `src/common/printer_variant/{coreone,coreonel}.hpp`, `lib/WUI/link_content/{basic_gets,prusa_link_api_v1,prusa_api_helpers}.cpp`, `lib/WUI/nhttp/{status_renderer,gcode_upload,server,req_parser}.cpp`, `lib/WUI/wui_api.cpp`, `src/state/printer_state.cpp`, `utils/gen-automata/http.py`                     |
| Pi    | [`prusa3d/Prusa-Link@58a0ab17`](https://github.com/prusa3d/Prusa-Link/tree/58a0ab1703680c32d39c76684e906c8f2ea91464)                                | `prusa/link/web/{main,files,cameras}.py`, `prusa/link/web/lib/{auth,files}.py`, `prusa/link/{const,conditions}.py`. `api_version` was also read at tag [`0.8.1`](https://github.com/prusa3d/Prusa-Link/blob/31e85687953b7b91c14ba8522293cd135f4c39ba/prusa/link/web/main.py), and so were the job routes and `get_boolean_header` at the pinned commit. |

The OpenAPI file's `Version` example says API `1.0.0` and printer `1.3.1`. Both vendor servers answer API `2.0.0` (Buddy `basic_gets.h`, `PL_VERSION_STRING`, also at tags `v5.1.2`, `v6.2.6`, `v6.4.0`, `v6.10.3`, `v7.0.1`; Pi `main.py`). The adapter previously accepted only `1.x`, which would have refused every one of those servers. It now accepts major 1 or 2.

## Models and firmware

`packages/connector/src/prusa/models.ts` holds this table. `prusaLinkBinding()` builds the v8 driver entry from a catalog name.

The identity firmware is the earliest stable release found whose [release notes](https://github.com/prusa3d/Prusa-Firmware-Buddy/releases) cover the model and whose tagged `basic_gets.cpp` emits `printer`. The tagged source lacks that field at `v6.2.6`, `v6.4.0`, `v6.4.1` and `v6.4.2`, and has it at the sampled tags from `v6.5.1`. Older firmware therefore fails the identity check. Not every tag or model build was read, and no release is a qualified operating minimum.

| Catalog model    | Host         | `printer` | Identity firmware | Connector binding | Catalog status |
| ---------------- | ------------ | --------- | ----------------- | ----------------- | -------------- |
| Prusa CORE One   | Buddy        | `7.1.0`   | 6.5.3             | bindable          | unqualified    |
| Prusa CORE One+  | Buddy        | `7.1.0`   | 6.5.3             | bindable          | unqualified    |
| Prusa CORE One L | Buddy        | `8.1.0`   | 6.5.1             | bindable          | unqualified    |
| Prusa XL         | Buddy        | `3.1.0`   | 6.10.1            | bindable          | unqualified    |
| Prusa MK4        | Buddy        | `1.4.0`   | 6.5.3             | bindable          | unqualified    |
| Prusa MK4S       | Buddy        | `1.4.1`   | 6.5.3             | bindable          | unqualified    |
| Prusa MK3.9      | Buddy        | `1.3.9`   | 6.5.3             | bindable          | unqualified    |
| Prusa MK3.9S     | Buddy        | `1.3.10`  | 6.5.3             | bindable          | unqualified    |
| Prusa MK3.5      | Buddy        | `1.3.5`   | 6.5.3             | bindable          | unqualified    |
| Prusa MK3.5S     | Buddy        | `1.3.6`   | 6.5.3             | bindable          | unqualified    |
| Prusa MINI       | Buddy        | `2.1.0`   | 7.0.0             | bindable          | unqualified    |
| Prusa MINI+      | Buddy        | `2.1.0`   | 7.0.0             | bindable          | unqualified    |
| Prusa MK2.5      | Raspberry Pi | none      | not applicable    | refused           | unqualified    |
| Prusa MK2.5S     | Raspberry Pi | none      | not applicable    | refused           | unqualified    |
| Prusa MK3        | Raspberry Pi | none      | not applicable    | refused           | unqualified    |
| Prusa MK3S       | Raspberry Pi | none      | not applicable    | refused           | unqualified    |
| Prusa MK3S+      | Raspberry Pi | none      | not applicable    | refused           | unqualified    |

- **Shared identities.** CORE One and CORE One+ report the same tuple, as do MINI and MINI+. The "+" CORE One editions are firmware variants of one model. The wire cannot tell these apart, so the model name is the operator's declaration. The CORE One L+ variant likewise reports `8.1.0`.
- **Configurable identities.** Buddy formats the _current_ model. `src/common/extended_printer_type.cpp` lets the MK4/MK3.9, MK3.5 and XL firmware families select a type, so the tuple reflects the printer's setting, not a hardware probe.
- **Refused: MK2.5 and MK3 families.** Pi `api_version` returns no `printer` field, at `0.8.1` and at the pinned commit, so the v8 identity check can never pass. Its `original` string names only a type from `const.py` (MK2.5, MK2.5S, MK3, MK3S), with no MK3S+. Binding on free text was not added. The Buddy table's `MK3` and `MK3S` entries are not evidence that those printers run Buddy.
- **No catalog row, no binding:** XL+ (`3.1.1`, so an XL binding refuses it), CORE One INDX (`7.10.0`), CORE One L INDX (`8.10.0`), the XL dev kit (`5.1.0`) and SL1/SL1S.

## Operations

"Simulator" means `startPrusaLinkPrinterSimulator` in `packages/sim-tools/src/prusa-simulator.ts`. Tests are in `tests/node/prusa-models.test.ts` and assert on what the simulator reports after each operation.

| Adapter operation      | Source behaviour (Buddy; Pi where it differs)                                                                                                                                      | Reported outcome asserted in the simulator                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `discover`             | `GET /api/version`, `GET /api/v1/info`                                                                                                                                             | Per-model tuple and serial. API `3.x` refused.                                                                      |
| `status`               | `GET /api/v1/status`; `job` only while a job is active                                                                                                                             | State and job presence after every transition.                                                                      |
| `upload`               | Raw `PUT /api/v1/files/usb/…`, 201. `Overwrite: ?0`, no `Print-After-Upload`. Pi writes `local`; `sdcard` is read-only (409).                                                      | File report shows the stored size; state stays `IDLE`. A second upload gets 409 and keeps the first bytes.          |
| `start`                | `POST` on the file: 204, 404 missing, 409 not ready                                                                                                                                | `PRINTING`, and `/api/v1/job` names the file.                                                                       |
| `control` pause        | 204 only from `PRINTING`. Buddy's pausing states report `PAUSED`; Pi queues the command.                                                                                           | `PAUSED` (Pi: only after the printer applies it).                                                                   |
| `control` resume       | 204 only from `PAUSED`. Buddy's resuming states still report `PAUSED`.                                                                                                             | `PAUSED` after the 204, then `PRINTING`.                                                                            |
| `control` cancel       | `DELETE` on the job: 204 while printing or paused (Buddy also from attention). Buddy's aborting states report `PRINTING`. A wrong job id gets 404.                                 | `PRINTING` after the 204, then `STOPPED` with no job.                                                               |
| `camera`               | Pi: `/api/v1/cameras/snap` gives 404 without a camera, 204 before a first photo, otherwise an image. **Buddy: no camera route** (no `camera` match in `lib/WUI` at the pinned tag) | Pi: 404, then no image, then the image bytes. Every Buddy model: 404. The spec lists the route; Buddy lacks it.     |
| Connect Local (4 read) | Existing routes, not re-verified here. The simulator's reply shapes are synthetic.                                                                                                 | `discover`, `status`, `history` and `camera` reflect the simulated printer and its ended jobs. No per-model claims. |

A 2xx is only an acknowledgement. The test drops a pause reply after the simulator applies it: the call fails, exactly one request is sent, and the next status read reports `PAUSED`. A denied send guard produces no request.

## Refusals

| Refused                                           | Why                                                                                                                                                                                   | Enforced by                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Every command through the Connector               | v8 PrusaLink assignments are read-only handles. Signed command wiring waits for hardware evidence and owner approval ([registration contract](../DRIVER-REGISTRATION.md)).            | `provisionReadonlyPrinter`; `tests/unit/prusa-runtime.test.ts`     |
| MK2.5 and MK3 family bindings                     | No model identity on the wire (Pi source above).                                                                                                                                      | `prusaLinkBinding`; the collector also withdraws a Pi-shaped reply |
| A printer whose tuple differs from the binding    | Identity mismatch, checked before any status read.                                                                                                                                    | `runtime/prusa-link-collection.ts`                                 |
| Buddy storage other than `usb`                    | `parse_file_url` answers 403 outside `/usb/`.                                                                                                                                         | Firmware; simulated                                                |
| Overwriting an existing file                      | The adapter sends `Overwrite: ?0`; both servers answer 409.                                                                                                                           | Adapter and server                                                 |
| Print on upload                                   | The adapter omits `Print-After-Upload`. Buddy accepts `true`, `1` and `?1`; Pi accepts `?1`.                                                                                          | Adapter                                                            |
| Digest authentication                             | Both servers accept `X-Api-Key`, which is all the adapter sends. A wrong key gets 401 on Buddy and 403 on Pi.                                                                         | Adapter                                                            |
| Temperature, fan, motion, material, file deletion | Not implemented. The pinned v1 spec has no temperature, fan or motion route. Buddy has a file `DELETE`, which the adapter does not call. Pi's legacy `/api/printer/*` routes are out. | Not implemented                                                    |

## Simulator and journey coverage

- **Operations.** One lifecycle test per bindable catalog model (12) over loopback HTTP, plus Buddy refusals, lost reply, Pi behaviour, API version and Connect Local reads. The models differ only in the reported tuple: the simulator models no per-model hardware difference.
- **Connector collection.** One run of the real collector holds a printer for each of the 10 distinct tuples through idle, printing, paused and finished. A mismatched tuple and a Pi host stay unavailable.
- **Browser journeys.** `tests/journey/prusa-link.spec.ts` now defines one read-only journey per distinct tuple (10): printing, connection loss, recovery. They are opt-in and outside `check:all`. They have **not passed** for this change: on the authoring host both the Prusa and the Formlabs journey stopped at the harness sign-in page (`page.goto: Target page, context or browser has been closed`). The journey fixture, its runtime configuration and the PrusaLink collection loop were run without a browser for all 12 bindable models (printing, unavailable, idle; `GET` only).

## Gaps

- No hardware qualification for any model, firmware or operation.
- The simulator follows the cited handlers but runs no firmware. It does not model transfer slots, print-preview questions, `ATTENTION`, `BUSY`, `READY`, power loss, crash recovery or MMU. It ignores a command's effect once a later command replaces it; firmware behaviour for overlapping commands is unverified.
- On Buddy, an upload without `Print-After-Upload` still calls `print_start` when the printer is ready (`wui_api.cpp`, "best effort" preview), so the screen may change even though no print is requested. A start can also stop at an on-printer preview question. Both need hardware checks before writes are enabled.
- Buddy status reports only the active tool's temperatures and fans. There is no per-tool telemetry for XL.
- The collector maps `BUSY`, `READY`, `ATTENTION` and other unlisted states to `unknown`.
- The published identity is the raw tuple (for example `1.4.0`), not the catalog name. Mapping it for the UI and compatibility views is not part of this change.
- `tests/fixtures/prusa/link.json` is synthetic: its firmware `6.4.0` with a `printer` field does not match the `v6.4.0` source.
- `DRIVER-REGISTRATION.md` still describes the adapter as API `1.x`, and `DRIVER-EVIDENCE.md` is not yet linked to this file.
