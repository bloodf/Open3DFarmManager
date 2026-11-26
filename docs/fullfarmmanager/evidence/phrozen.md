# Phrozen resin: driver evidence

Checked 2026-11-25. Every model stays **unqualified**. No physical printer was contacted. All fixtures and state transitions are synthetic. No source below is a Phrozen protocol document or a capture from a Phrozen printer.

## Sources

| Id  | Source                                                                                                                                                                                                                 | What it establishes                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | [Phrozen video, Revo remote printing and monitoring](https://www.youtube.com/watch?v=ngnSR3nWJGw) (title and description read; footage not reviewed)                                                                   | CHITUBOX 2.1 or later prints to and monitors the Sonic Mighty Revo on V138, with time-lapse. The description names no protocol, pause, stop or live video.                           |
| P2  | [Phrozen firmware release notes](https://helpcenter.phrozen3d.com/hc/en-us/articles/6369983852569-Firmware-downloads-and-release-notes)                                                                                | Revo 14K: V138 adds time-lapse, V149 (2025-08-22) "Add streaming functionality", V153 is the latest. "Streaming" names no protocol and no client.                                    |
| D1  | [Distributor guide, Revo 14K/16K](https://www.iguazu-phrozen.jp/operation_guide/sonic_mighty_revo) (Japanese)                                                                                                          | ChituManager "network send" transfers a sliced file to a Sonic Mighty Revo. Prints sent this way are kept in local storage.                                                          |
| C1  | [ChituManager management](https://docs.chitubox.com/en-US/chitu-manager/latest/ui-and-features/management) and [network sending](https://docs.chitubox.com/en-US/chitu-manager/latest/ui-and-features/network-sending) | LAN device scan, a per-printer "SDCP protocol version" field, file transfer then print. Not model-specific. Its printer compatibility list is a separate page that was not readable. |
| C2  | [ChituManager operations](https://docs.chitubox.com/en-US/chitu-manager/latest/ui-and-features/operations)                                                                                                             | Pause, resume, stop, file list, video when a camera is connected, and history with "actual consumption". Not model-specific.                                                         |
| S1  | [CBD SDCP V3.0.0, commit f977215](<https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/f977215761ee2e8c6d02ab06a68dc4d2b710a255/SDCP(Smart%20Device%20Control%20Protocol)_V3.0.0_EN.md>)        | The wire contract of the mainboard maker: discovery, commands, history fields, RTSP video and HTTP upload. It does not mention Phrozen.                                              |

## How far "verified" goes

For the Revo 14K, P1, P2 and D1 show that the workflows exist. C1, C2 and S1 describe how Chitu software and SDCP carry them. The link between the two is an inference: no source says in words that Phrozen firmware speaks SDCP V3.0.0. The adapter therefore acts only when the printer itself answers discovery with the exact 14K name, V138 or V153 and `V3.0.0`, and, before control, upload or video, reports the matching capability through command 1. Every operation below is **spec-derived**, not confirmed on hardware.

Pause, resume and stop have no Phrozen-specific source for the LAN path. They rest on C2 and S1.

## Per model

| Model                     | Connector operations                                                       | Reason                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sonic Mighty Revo 14K     | V153: status, control, upload, video, task usage. V138: same without video | Chain above. V138 predates the V149 streaming note (P2). V149 itself is outside the discovery allowlist. These are adapter operations; see Runtime wiring for what the Connector reaches.                                                                                                                                          |
| Sonic Mighty Revo 16K MAX | None; refused at discovery                                                 | Phrozen documents [network or USB file transfer](https://helpcenter.phrozen3d.com/hc/en-us/articles/62991136236185-Sonic-Mighty-Revo-16K-MAX-Your-First-Print). No protocol, identity reply or LAN control source was found.                                                                                                       |
| Sonic Mighty Revo 16K     | None; refused at discovery                                                 | D1 covers ChituManager sending for 14K and 16K, but no source gives the 16K `MachineName`, protocol version or reply.                                                                                                                                                                                                              |
| Sonic Mini 8K S           | None; refused at discovery                                                 | The [connection table](https://helpcenter.phrozen3d.com/hc/en-us/articles/6318209436441-Comparing-Connection-Methods-WiFi-USB-and-Ethernet), as recorded in [catalog-resin.md](../catalog-resin.md), gives USB only.                                                                                                               |
| Sonic Mighty 8K           | None; refused at discovery                                                 | [Sharing Network file import](https://helpcenter.phrozen3d.com/hc/en-us/articles/13080783999769--Sonic-Mighty-8K-Internet-Connection-File-Import) has the user turn on Sharing Network, enter the printer's IP on a computer and sign in with a username and password. Its text names no protocol and covers no status or control. |

## Operations

Code: `packages/connector/src/phrozen/`. "Simulator" is `packages/sim-tools/src/phrozen-simulator.ts`, which applies each operation to its own state and reports that state back. Tests: `tests/node/phrozen-control.test.ts` (control, upload, video) and `tests/node/phrozen-resin-usage.test.ts` (usage).

| Operation                  | Wire (S1)                          | Workflow source | Refused unless the printer reports                                         | Confirmed by                                                       | Simulator coverage                                                |
| -------------------------- | ---------------------------------- | --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Status                     | Cmd 0                              | P1              | n/a                                                                        | Board-scoped status frame                                          | Reports current state; one sub-state step per request             |
| Attributes                 | Cmd 1                              | C1              | n/a                                                                        | Board-scoped attributes frame                                      | Editable attributes                                               |
| Start (`/local/`, layer 0) | Cmd 128                            | P1, C1          | `PRINT_CONTROL`, file listed, machine idle, sub-status 0, 8 or 9           | New `TaskId` with that file, homing or printing                    | Creates a task and history record                                 |
| Pause                      | Cmd 129                            | C2              | `PRINT_CONTROL`, the caller's `TaskId`, sub-status 2 to 4                  | Same task at sub-status 6                                          | 5, then 6                                                         |
| Resume                     | Cmd 131                            | C2              | `PRINT_CONTROL`, same task at sub-status 6, `ErrorNumber` 0                | Same task at sub-status 2 to 4                                     | 4, then 3                                                         |
| Stop                       | Cmd 130                            | C2              | `PRINT_CONTROL`, same task printing or paused                              | Same task at sub-status 8                                          | 7, then 8 and a stopped history record                            |
| Upload                     | HTTP `/uploadFile/upload`, Cmd 258 | D1, C1          | `FILE_TRANSFER`, listed file type, idle, no file of that name in `/local/` | The name appears in the file list                                  | Checks offsets and MD5; stores bytes                              |
| Enable video               | Cmd 386                            | C2, P2          | V153, `VIDEO_STREAM`, `CameraStatus` 1, a free stream slot                 | `rtsp:` URL on the provisioned host, without credentials           | Video switch and URL                                              |
| Disable video              | Cmd 386                            | C2              | n/a                                                                        | Acknowledgment only (`acknowledged`); SDCP reports no switch state | Video switch                                                      |
| Task usage                 | Cmd 321                            | C2              | One record with that `TaskId`                                              | `CurrentLayerTalVolume`; missing, zero or non-numeric is unknown   | History with volume present, absent, late, zero, negative or text |

Result rules:

- `refused` means the printer did not act: a precondition failed, the request never left, the printer answered a non-zero Ack, or it rejected an upload packet.
- `uncertain` means it may have acted: lost reply, state not observed in time, or a video address that fails the checks. Nothing is resent. Later start, pause, resume, stop and upload calls are refused until `acknowledgeUncertain()` is called after a person checks the printer. This includes stop.
- Confirmation repeats only reads (commands 0 and 258).
- The reply example for command 258 in S1 shows `"Cmd": 192`. The adapter requires the echoed command to be 258, so firmware that really answers 192 would be refused.
- SDCP on the LAN has no authentication or encryption.

## Runtime wiring

What a signed-in user can reach. Every write is gated on `PHROZEN_QUALIFIED_WRITES` (`phrozen/qualification.ts`), a list of exact model and firmware pairs that **ships empty**. With it empty, status is all there is. An assignment opted into `pause.control` for an unqualified pair stops the Connector at startup (`Backend does not support pause control`), as before. A qualified pair gets a command binding, and the router, the driver and the upload each check the list again. The CLI cannot change the list; only tests pass another one.

| Operation           | Runtime path (qualified pair and local opt-in only)                                                 | Behaviour                                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status              | v8 collector, all pairs (read-only)                                                                 | Sub-status 6 now shows as paused. Once controls are advertised it also reports `CurrentLayer / TotalLayer` as progress (0 when idle) and queues telemetry, so the server can issue authority.                                |
| Pause, resume, stop | Signed command → dispatcher → `phrozen/control-driver.ts` (the API envelope path shares the router) | Acts on the `TaskId` read at preparation. Refusals before the write are `DriverRefusalError`. The dispatcher's guard runs immediately before the frame. An uncertain result holds later writes until the Connector restarts. |
| File transfer       | Control-peer file channel with a signed capability → `phrozen/upload.ts`                            | `.ctb` and `.prz` only, never as a job delivery or library print. The capability and printer state are rechecked before every packet.                                                                                        |
| Start               | Refused                                                                                             | `start_print` is advertised because the transfer authority requires it, but every start is refused before the write. The web UI shows no start control for a Phrozen printer.                                                |

Refused at runtime, with the reason:

- **Start (128).** A resin file starts only as a validated library version, and `resin-artifacts.ts` has no Phrozen format or printer profile. The adapter's start has no runtime caller.
- **Video (386).** Enabling the stream writes to the printer, so it needs a signed command, and a camera session admission is not one. The protocol has a signed `set_camera_stream` action (used by Flashforge), and Elegoo switches its SDCP stream with the signed `power` action and an `sdcp-rtsp` camera source. Neither is wired for Phrozen and no camera source was added. The adapter's video calls have no runtime caller.
- **Task usage (321).** There is nowhere to put it: the server accepts only `manual` resin entries and `PrinterState` has no resin volume field. `openPhrozenResinAccounting` has no runtime caller.

The web file page accepts only `.gcode` and `.3mf`, so no browser user can pick a Phrozen file to send yet. The transfer path is exercised by `tests/journey/phrozen.spec.ts` without a browser.

Journey (`tests/journey/phrozen.spec.ts`, simulator only): the shipped list gives status with no control, through a connection loss; file transfer is refused for unqualified pairs and succeeds with a test-only qualification; with the same test-only qualification (`tests/helpers/phrozen-qualified-connector.ts`, the Connector from source) a browser pauses, resumes and cancels, and is offered no start. A start sent through the Connector router is refused. `tests/node/phrozen-runtime.test.ts` covers the refusals at router and driver level.

## Not implemented

| Operation                                                  | Source                | Why                                                                |
| ---------------------------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| Stop feeding (132), skip preheating (133)                  | S1                    | No Phrozen or ChituManager source for either.                      |
| Delete files (259)                                         | S1                    | Destructive and not needed.                                        |
| Terminate transfer (255)                                   | S1                    | A failed upload sends no follow-up command.                        |
| Rename printer (192)                                       | S1                    | Not needed.                                                        |
| Time-lapse switch (387) and download                       | P1, P2, S1            | Not needed for control, camera or usage.                           |
| Start from `/usb/`, or from a layer above 0                | S1                    | Only a file confirmed in local storage starts, from the beginning. |
| Overwrite a file                                           | S1                    | A list entry could not then confirm the new content.               |
| Axis motion, exposure and LCD tests, heating, resin feeder | S1 defines no command | No wire source.                                                    |
| Phrozen GO                                                 | Vendor app            | Account-based vendor service; no public API found.                 |

## Resin usage

The printer's `CurrentLayerTalVolume` is "Total Volume of Printed Layers(ml)" (S1). C2 lists "actual consumption" in history, without naming this field. No source says the value is a physical measurement. It is probably computed from the sliced layers, so it would leave out resin lost to the vat, drips and cleaning. This is unverified. The Connector never derives usage from progress or layer counts.

The existing ledger has no consumption entry. Its vat `volume` entry is the volume left, and the summary shows the latest one. `openPhrozenResinAccounting` therefore appends `last reading − reported usage` as a `reported` entry, at most once per run key (SHA-256 of mainboard id and `TaskId`), journaled before the append. The `reported` result can rest on a manual reading; the ledger has no label for a derived value.

It appends nothing when:

- the task is not settled or has no end time (nothing journaled; it can be offered again);
- the volume is unknown (a later report with a volume can replace this);
- the start time or the vat reading is unknown, or the reading is not older than the start;
- an earlier journaled run ended after the reading and did not reach the ledger;
- usage exceeds the reading;
- the run key already has any other result.

A lost, late or malformed append reply, or a restart during an append, is `uncertain` and is never retried. `resolveUncertain` records what an operator found and sends nothing. A new manual vat reading lets later runs be debited again. A failed ledger read claims nothing. The journal never evicts keys and stops at 10,000 entries.

Limits:

- A run that is never passed to `recordRun`, for example one printed while the Connector was off, cannot be detected. The next debit would then overstate what is left.
- Run times come from the printer clock and reading times from the server clock. A wrong printer clock can defeat either time check.
- Recording a run only after the next one has started leaves the next one unknown.
- Reading and appending are separate calls. A manual reading saved between them would be hidden by the debit.

## Gaps

1. Capture discovery, attributes, status, history, file list, upload and video replies from a Revo 14K on V138 and V153. Confirm the identity strings and that the firmware speaks SDCP at all.
2. Confirm that status carries `TaskId`. The older status fixture has none. Without it, start ends `uncertain`, and pause, resume and stop are refused.
3. Confirm the `CurrentLayerTalVolume` meaning, its value for stopped runs, and when it is written.
4. Confirm that V153 video is LAN RTSP and not only Phrozen GO app streaming.
5. Runtime wiring stops at status, pause, resume, stop and file transfer (see Runtime wiring). Start needs a Phrozen entry in the resin artifact contract with a validator; video needs a signed stream switch wired for Phrozen; usage needs gap 6. The web file page does not accept resin files, there is no runtime file list, and an uncertain hold is cleared only by restarting the Connector.
6. No production ledger sink exists. The server accepts only `manual` entries (`resin-ledger/request.ts` and `resin-ledger-postgres.ts`), and no Connector-to-server resin transport exists. `PhrozenResinLedger` is the port to implement. An atomic server-side debit keyed by run key, with its own consumption kind, would remove the read-then-append gap and the provenance ambiguity.
