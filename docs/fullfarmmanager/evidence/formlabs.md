# Formlabs driver evidence

Evidence is simulator only. No printer or PreForm host was contacted. Every
catalog row stays unqualified.

## Sources

- S1: [PreForm API v1.0.0-alpha.1 reference](https://developer.formlabs.com/api-reference/)
  and its [OpenAPI file](https://developer.formlabs.com/reference/openapi-v1.yml),
  retrieved 2026-11-25. All `/v1/` routes below come from it.
- S2: [Devices reference](https://developer.formlabs.com/api-reference/devices/).
- S3: [Local API 0.9.11](https://formlabs-dashboard-api-resources.s3.us-east-1.amazonaws.com/formlabs-local-api-v0.9.11.html),
  the source of the registered `GET /devices/` collection.
  [Local API 0.9.30](https://formlabs-dashboard-api-resources.s3.amazonaws.com/formlabs-local-api-latest.html)
  was also read and lists no job cancel, pause or resume route.
- S4: [Web API](https://formlabs-dashboard-api-resources.s3.amazonaws.com/formlabs-web-api-latest.html),
  the Dashboard cloud service. It is not a local API.

## Scope

- `formlabs/index.ts` and `runtime/formlabs-collection.ts` publish live Form 4
  and Form 4L host status through `GET /devices/` (S3). They issue no write.
- `formlabs/operations.ts` is an adapter library over the v1 routes (S1). The
  Connector command pipeline does not call it. No assignment, envelope, journal
  or UI path exposes upload or start, and `command()` still returns
  `unsupported`.

## Operations

| Operation            | Form 4, Form 4L                 | Form 3, Form 3+, Form 3L        | Documented route or reason                                                                   |
| -------------------- | ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| Status               | implemented                     | implemented, adapter only       | `GET /v1/device/list/` (S1, S2)                                                              |
| Upload to queue      | implemented, adapter only       | implemented, adapter only       | `POST /v1/scene/print/` with `print_now: false` (S1)                                         |
| Start with an upload | implemented, adapter only       | implemented, adapter only       | `POST /v1/scene/print/` with `print_now: true` (S1)                                          |
| Job list             | refused `unsupported-operation` | refused `unsupported-operation` | No local route. `/v1/operation/list/` lists server operations (S1). S4 has cloud print lists |
| Start a queued job   | refused `unsupported-operation` | refused `unsupported-operation` | No route (S1)                                                                                |
| Cancel               | refused `unsupported-operation` | refused `unsupported-operation` | No route (S1, S3)                                                                            |
| Pause, resume        | refused `unsupported-operation` | refused `unsupported-operation` | No route (S1, S3)                                                                            |
| Discovery            | refused `unsupported-operation` | refused `unsupported-operation` | Documented (S2). Left out: the adapter reads one configured device                           |
| Firmware upload      | refused `unsupported-operation` | refused `unsupported-operation` | Documented (S2). Left out: the Connector never changes firmware                              |

Upload and start also use `POST /v1/print-setting/list/` with
`compatible_with`, `POST /v1/scene/open/` and `DELETE /v1/scene/delete/` (S1).

## Live reading

| Reading          | Result                   | Source or reason                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model binding    | implemented              | Each binding declares `model` (`Form 4` or `Form 4L`). A host `product_name` that differs, ignoring case, withholds the reading (`model mismatch`). The bound model is published as identity. `product_name` is a shared device field (S3); "Form 4" appears in S1 examples |
| Host status text | implemented, unchanged   | `status` (S3). S1: human-readable, never match on its value. Shown verbatim                                                                                                                                                                                                 |
| Firmware         | implemented              | `firmware_version` (S3), published as identity only                                                                                                                                                                                                                         |
| Remaining time   | implemented              | `estimated_print_time_remaining_ms` in the "Form 4 or Form 4L Printer" shape (S3); S1: "milliseconds remaining in the current print, if any, and 0 otherwise". Only a positive value is published. A malformed value is dropped and the status is kept                      |
| Printer state    | refused, stays `unknown` | No machine-readable state field (S1, S3). `status` must not be matched. A zero remaining time does not tell idle from paused, error or finished                                                                                                                             |
| Progress         | refused                  | No percentage, layer or total duration for Form 4 (S1, S3). The farm protocol requires progress for `printing`                                                                                                                                                              |
| Materials        | refused                  | `tank_material_code` and `cartridge_data` are documented (S3). The farm `materials` slots are filament trays tied to Spoolman spool assignment; resin tanks and cartridges have no representation there                                                                     |
| Camera           | refused                  | No printer camera route (S1, S3). The screenshot routes render the PreForm scene                                                                                                                                                                                            |
| Cancel, history  | refused                  | No local cancel route (S1, S3). No local print history route (S1, S3); S4 is a cloud service                                                                                                                                                                                |

No new write path was added. Upload and start remain the adapter-only library
below; the Connector command pipeline does not call it.

## Per-model evidence

| Model         | In catalog | Model-specific source                                                                                      | Simulator coverage                     | Gaps                                                                                         |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Form 4        | yes        | Device shape "Form 4 or Form 4L"; `product_name` and `FORM-4-0` appear in examples (S1)                    | status, upload, start, safety refusals | Hardware, firmware and PreForm version unqualified                                           |
| Form 4L       | yes        | Same device shape (S1)                                                                                     | status, upload, start                  | `product_name` string and machine type id unverified; the simulator id is a placeholder      |
| Form 3, 3L    | no         | Device shape "Form 3 or Form 3L" (S1, S3)                                                                  | status, upload, start                  | `product_name` strings and machine type ids unverified; not in the live collection           |
| Form 3+       | no         | S1 does not name it                                                                                        | status, upload, start                  | Use of the Form 3 shape and the `product_name` string are assumptions; a mismatch is refused |
| Form Studio 1 | yes        | None found in S1 or S3 for a device shape or `product_name`                                                | refusal only                           | All operations refused `unsupported-model`                                                   |
| Others        | no         | Form 2 and Fuse 1 have documented shapes (S1, S3) but are outside this unit. Others have no verified shape | refusal only                           | All operations refused `unsupported-model`, including Form 3B, 3B+, 3BL, 4B, 4BL and Form 1+ |

## Safety behavior

- Writes require a loopback host. S1 says file paths refer to the server's
  machine, the server listens on localhost and it has no API keys.
- The input is one absolute `.form` path with exactly one scene. Its machine type
  must be listed by the host for the configured printer.
- The target is always the configured device ID. `REMOTE` and `VIRTUAL` devices
  are refused. The adapter never calls `/v1/login/`.
- `print_now` is always sent. S1 says omitting it can start the print.
- Start requires `ready_to_print_now` and zero remaining time, checked before
  opening the file and again before sending.
- The print request is sent once. A lost or unreadable reply, a server error or
  `OPERATION_FAILED` is `uncertain`, with no retry. Only request validation codes
  and `PAYLOAD_TOO_LARGE` are reported as refused by the host.
- One adapter instance runs one write at a time. This does not coordinate other
  instances or other PreForm clients.
- An opened scene is deleted afterwards, except after an `uncertain` print.

## Limits of reported state

- An upload result is `accepted` with `confirmation: 'none'`. The job ID is the
  host's acknowledgement. The API reports no printer queue.
- A start result is `printing` only after a later read reports remaining time.
  Device status has no job ID for these families, so it does not identify the
  job. Otherwise the result is `uncertain` (`start-not-reported`).
- `status` text is human-readable. S1 says never to match on it.
- There is no printer observation time. PreForm may report cached data.
- The meaning of `is_remote_print_enabled` for local prints is unverified. S1
  describes it for starts through Dashboard. It is reported and does not gate.
- S1 is an alpha version. Which PreForm releases serve both `/devices/` and
  `/v1/device/list/` is unverified.

## Journey

`tests/journey/formlabs.spec.ts` runs against the loopback simulator and a
spec-derived fixture (`tests/fixtures/formlabs/devices.ts`). It opens the farm
inspector, checks the host status and an estimated remaining time of 1 h 30
min, withdrawal on a 503, recovery to Idle with no remaining time, and
withholding when the host lists another model under the bound ID. The Connector
sends only `GET /devices/`. No control is offered.

The earlier sign-in failure came from the browser environment: the journey
needs the bundled browser environment sourced. With it sourced, sign-in passes;
the spec then failed because the farm wall now lists each printer as an
inspector tile. The spec opens the inspector.

## Simulator coverage

`packages/sim-tools/src/formlabs-simulator.ts` keeps a queue and a current print
for each synthetic printer. Upload and start change that state. Start is also
visible through the v1 device list. Queue contents are read through
`printerState()`, a test accessor, because the API has no queue route. It also
simulates open scenes, host error replies, dropped connections before and after
an effect, and a start that is never reported. Error timing and `.form` contents
are synthetic.

Tests: `tests/node/formlabs-operations.test.ts`. The `GET /devices/` behavior
is covered by `tests/node/formlabs-protocol.test.ts`,
`tests/unit/formlabs-runtime.test.ts` (model binding, remaining time, malformed
fields) and the journey above.
