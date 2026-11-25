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

- `formlabs/index.ts` and `runtime/formlabs-collection.ts` are unchanged. They
  publish live Form 4 and Form 4L host status through `GET /devices/` (S3).
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

## Simulator coverage

`packages/sim-tools/src/formlabs-simulator.ts` keeps a queue and a current print
for each synthetic printer. Upload and start change that state. Start is also
visible through the v1 device list. Queue contents are read through
`printerState()`, a test accessor, because the API has no queue route. It also
simulates open scenes, host error replies, dropped connections before and after
an effect, and a start that is never reported. Error timing and `.form` contents
are synthetic.

Tests: `tests/node/formlabs-operations.test.ts`. The earlier `GET /devices/`
behavior remains covered by `tests/node/formlabs-protocol.test.ts` and the
Formlabs unit tests.
