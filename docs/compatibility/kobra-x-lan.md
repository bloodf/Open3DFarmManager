# Anycubic Kobra X LAN protocol (clean-room specification)

Status: clean-room protocol description for OpenFarm's native Kobra X adapter (E16.17, E16.21).
License of this document: MIT, same as OpenFarm.

## Purpose and clean-room rules

OpenFarm connects directly to the Kobra X over its native LAN endpoints.
This document records the protocol facts and message shapes used by the
MIT-licensed adapter. KobraLink and other third-party sources contribute only
reported protocol observations.

Rules for anyone editing this document or implementing from it:

- Facts only. This document contains no code, no function bodies, no parsers and no decryption
  routines. Message shapes are described as field names, types and allowed values.
- Do not copy prose or code from the sources listed in [Sources](#sources). Facts are restated in
  this document's own words.
- No Anycubic certificate, private key, token, password or serial number is committed to the
  repository. Examples use placeholders such as `<printer-ip>`, `<token>`, `<modelId>`, `<deviceId>`.
- Every fact carries a status and a source. Items the adapter must not rely on until a capture
  exists are listed in [Unverified items](#unverified-items).

## Status and source legend

Status tags on every fact:

| Tag            | Meaning                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `observed`     | Seen on a real Kobra X running firmware 2.0.2.8 (captured by the source owner).                                                             |
| `reported`     | Stated by a source that did not capture it on a Kobra X here: GPL/AGPL projects or strings in an Anycubic binary. Not verified by OpenFarm. |
| `not verified` | Named in a source as a message or option, but no answer or effect has been captured. Do not depend on it.                                   |

Source tags:

| Tag | Source                                                             | License              | How it is used here                                                        |
| --- | ------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------- |
| S1  | kobracontrol protocol notes (owner-provided `docs/protocol.md`)    | owner-provided       | Primary fact source. Carries the owner's observations on firmware 2.0.2.8. |
| S2  | Kobralink `packages/kobra-protocol` (as summarized in S1)          | GPL-3.0              | Reported facts only. No code was read or copied.                           |
| S3  | KX-Bridge (as summarized in S1)                                    | GPL-3.0              | Reported facts only. No code was read or copied.                           |
| S4  | Anycubic Slicer Next 1.x and 2.0.0.3 strings (as summarized in S1) | Anycubic proprietary | Reported facts only. No binary content is reproduced.                      |
| S5  | anycubic-orca-plugin, `anycubic_lan.py` (as summarized in S1)      | AGPL-3.0             | Reported facts only. No code was read or copied.                           |

S2 to S5 are cited as S1 reports them. OpenFarm has not read their code for this document. Their
facts stay `reported` until a Kobra X capture confirms them.

## Transports

| Port                                        | Protocol                   | Use                                                   | Status / source                                                             |
| ------------------------------------------- | -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| 1900 (UDP, multicast group 239.255.255.250) | SSDP                       | Printer discovery                                     | observed (S1)                                                               |
| 18910                                       | HTTP                       | `/info`, `/ctrl` credential recovery, `/gcode_upload` | `/info` observed (S1); `/ctrl` and upload observed in the owner's flow (S1) |
| 9883                                        | MQTT 3.1.1 over mutual TLS | Status reports, commands, print start                 | observed (S1)                                                               |
| 18088                                       | HTTP-FLV                   | Camera stream                                         | observed (S1)                                                               |

The printer must have LAN mode enabled. There is no cloud path. Anycubic Cloud and access from
outside the LAN are out of scope for this protocol. (observed, S1)

## Discovery (SSDP)

### Search

- The adapter sends `M-SEARCH` requests to the multicast group 239.255.255.250, port 1900.
- Search targets seen in replies or sent by sources: `ac:3dprinter:`, `ac:3dprinter:20030`,
  `ssdp:all`, `upnp:rootdevice`.
- `MX` values 1 and 2 were observed to work. (observed, S1)
- Unicast `M-SEARCH` to the printer's port 1900 also gets a reply. (observed, S1)
- Source S4 reports a slicer search with `ST: ac:3dprinter:<value>`, `MX: 5` and
  `Man: "ssdp:discover"`. The value filled in is not visible in the source. (reported, S4)
- Source S5 reports a single search with `ST: ssdp:all` and `MX: 2`, listening 2.5 s. (reported, S5)

### Reply from the Kobra X

- The printer answers each `M-SEARCH` with exactly one empty UDP datagram (0 bytes), sent from its
  own address on port 1900. (observed, S1)
- The printer sent no `NOTIFY` messages during 40 s of listening on the group. (observed, S1)
- Other devices on the same network answer `ssdp:all` with ordinary `HTTP/1.1 200 OK` text
  replies. (observed, S1)
- Source S4 reports that a slicer reads replies containing `ac:3dprinter:` and the fields `USN`,
  `modelId`, `ctrlType` (value `lan`) and `cn`. (reported, S4)

Because an empty reply carries no identity, the adapter must confirm a candidate with `GET /info`
(see below) before treating it as a printer.

### Candidate filtering (adapter rule, derived from S1)

S1 describes this policy and it fits an adapter that must not trust replies blindly:

- A sender is a candidate when it answers with an empty datagram, or with a text reply that
  contains `ac:3dprinter` or `:18910/`, and the reply came from port 1900.
- Other text replies are ignored and are never probed.
- At most 4 candidates per search are kept.
- Only the address the reply came from is used. Addresses or URLs inside a reply are never used.
- Only private, link-local or loopback IPv4 addresses are accepted.
- At most 64 replies of at most 2048 bytes are read per search.
- A sender counts as a printer only when its own `GET /info` answers with a LAN token.
- `/ctrl` is always asked of that same address. A `ctrlInfoUrl` inside `/info` is never followed.

The last two rules are safety rules. They keep discovery and credential recovery on the LAN address
that answered. (observed design in S1; the rules themselves are the owner's policy)

## HTTP on port 18910

### `GET /info`

Observed on firmware 2.0.2.8 (S1). Fields:

| Field         | Type / value                     | Note                                                                                                             |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cn`          | string                           | Used in the slicer's log line (S4).                                                                              |
| `ctrlInfoUrl` | URL                              | Points at `http://<printer-ip>:18910/ctrl` on the printer's own address. Adapter must not follow it (see above). |
| `ctrlType`    | `lan`                            | LAN mode indicator.                                                                                              |
| `deviceName`  | string, e.g. `Anycubic Kobra X`  | Display name.                                                                                                    |
| `deviceType`  | `fdm`                            | Device class.                                                                                                    |
| `env`         | string                           | Environment field. Value not documented in S1.                                                                   |
| `ip`          | string                           | Printer address.                                                                                                 |
| `modelId`     | string, e.g. `20030` for Kobra X | Used in MQTT topic paths.                                                                                        |
| `modelName`   | string                           | Model name.                                                                                                      |
| `token`       | string, 32 characters            | Needed for `/gcode_upload` and the camera URL. Never commit a real token.                                        |
| `usn`         | string                           | Unique service name field.                                                                                       |
| `zone`        | string                           | Zone field. Value not documented in S1.                                                                          |

### Credential recovery: `POST /ctrl`

The owner's clean-room follow-up (S6) documents credential recovery on firmware
2.0.2.8 with LAN mode enabled.

1. Read the 32-character ASCII token from `GET /info`. Use the confirmed sender
   address for both requests and ignore addresses and URLs in printer payloads.
2. Send an empty `POST /ctrl` with `Connection: close`. The query contains the
   current Unix time in milliseconds (`ts`), six random ASCII letters or digits
   (`nonce`), the signature (`sign`), and literal `did=random`.
3. Compute lowercase MD5 hex over the first 16 token characters. Concatenate the
   hex text with `ts` and `nonce`, then compute lowercase MD5 hex again to get
   `sign`.
4. Require HTTP 200 and JSON `code: 200`. Decode `data.info` as base64 and decrypt
   with AES-128-CBC and validated PKCS#7 padding. Use the final 16 token characters
   as the key and the 16 characters of `data.token` as the IV. Both are ASCII
   bytes.
5. Parse UTF-8 JSON. Use `username`, `password`, and `deviceId` and default an
   absent `modeId` to `20030`. Fail activation on invalid credentials or a
   printer refusal. Keep the recovered credentials in Connector memory.

The focused loopback test checks the supplied signature and ciphertext vectors.
They are synthetic and establish agreement with S6. Hardware TLS interoperability,
firmware compatibility, and browser acceptance require separate evidence.

### Hardware qualification route

Use the printer's direct native LAN endpoints for every Kobra X test and
qualification. Read identity from `/info` on port 18910 and use the printer's
MQTT broker on port 9883. Never use the cortex-kobralink Moonraker bridge for
Kobra X tests, qualification, or catalog evidence. Verify the direct printer
address from private configuration.

### Activation: native setup, persistence and confirmation (E16.22)

New Kobra X setup in the web UI uses the native `kobra-x` configuration backend
by default. The KobraLink bridge (`kobralink-anycubic`) stays available only as
an explicit "Usar ponte KobraLink (legado)" choice, and existing KobraLink
assignments and pending bridge operations are untouched.

1. The browser sends an IPv4 (private, port 18910) and the operator's own client
   certificate. The discovery panel can prefill the address from SSDP; discovery
   proves neither identity nor connection.
2. The Connector checks the configured printer networks and the identity port,
   then stages the client certificate in private custody (0600). During signed
   onboarding it captures the broker's public-key fingerprint on a TLS
   connection that sends no MQTT data. The subsequent broker login must match
   that fingerprint before MQTT credentials can be sent.
3. The Connector reads `/info`, recovers MQTT credentials in memory, and
   confirms login over the pinned mutual TLS connection. The credentials,
   `/info` token, and private key stay out of journal entries and receipts.
4. The existing signed review and commit persist the address, model ID, device
   ID, client certificate path, and SPKI SHA-256 pin in
   `kobra-x-bindings.json` next to the runtime file. Existing assignments and
   duplicate-identity checks still apply. Discovery alone writes no trust.
5. Collection uses the stored pin on every connection and rechecks the device
   identity. A certificate renewal that keeps the pinned public key works
   automatically. A different key takes the printer offline and leaves the
   stored pin intact. An HTTP `/info` response can identify a model and serial
   but cannot prove that a replacement public key belongs to that printer.

The Connector loads the binding into its local assignment mapping. Adding that
assignment to `pause.control.assignmentIds` enables the existing signed command
path for the native actions listed in [Kobra X detail capabilities](../protocols/kobra-x-detail.md).
The signed path has loopback evidence. The [hardware reports](../hardware-reports/)
record pinned LAN telemetry separately. Native camera media is unavailable.
Certificate-refusal and LAN-off diagnostics come from adapter errors.

### `POST /gcode_upload`

- Multipart upload to `http://<printer-ip>:18910/gcode_upload?s=<token>`. (observed, S1)
- Success response body: `{"code":200,"data":{"gcode":"<name>"},"message":"success"}`. (observed, S1)
- The multipart form-field name for the file is not documented in S1. (unverified gap)

## MQTT on port 9883

### Transport and TLS

- MQTT 3.1.1 over TLS on port 9883. (observed, S1)
- The broker requires a client certificate. (observed, S1)
- The broker accepts only a shared client identity: the certificate that Anycubic Slicer Next
  carries, whose subject is `CN=AnycubicSlicer`. (observed, S1)
- The client certificate and its key are not in this repository. OpenFarm must not bundle them. The
  adapter must obtain them from the user's own installation, through an explicit user action, and
  never from the repository. (policy; see [Security notes](#security-notes))
- The printer's server certificate is self-signed (observed, S1). The November
  23 owner report described one Kobra X certificate valid from 1970 to 1979.
  The driver uses an exact SPKI SHA-256 pin for new bindings and also accepts
  matching legacy leaf-certificate SHA-256 pins. It checks the pin before
  MQTT traffic. Pinned connections rely on the exact key or leaf match, so
  certificate dates do not block them. Unpinned connections use normal TLS
  verification. A generated 1970–1979 certificate exercises expiry handling
  in loopback tests.
- Trust modes. With no pin the connection uses normal TLS verification. With
  a pin only, the pin alone decides. With a CA and a pin together, both must
  hold: the chain must verify against the CA and the peer must match the pin,
  and either failing refuses the connection. (OpenFarm decision, loopback
  tested)
- The client certificate is held back until the printer is authenticated. Node
  verifies a server certificate only after its handshake, and in TLS 1.2 (and
  racily in 1.3) its client has already written the client certificate by then.
  The Kobra X client therefore requires TLS 1.3, where that certificate is part
  of the client's last flight, and keeps the flight in memory until the pin
  (and CA, when given) pass. Writes before the server's real ServerHello still
  leave, so a HelloRetryRequest (for example from a P-256-only peer) gets its
  second ClientHello and the handshake completes. A mismatching or TLS 1.2-only
  peer sees the ClientHello(s) and nothing else. (OpenFarm decision, loopback
  tested with default and P-256-only groups) The printer negotiated TLS 1.3 in the
  November 23 hardware report; firmware that cannot is refused, not downgraded.
  Pairing's first-use pin capture sends the certificate to an unverified peer by
  design.
- S1 reports that a working connection from OrcaSlicer's runtime (OpenSSL 1.1.1) used the cipher
  string `DEFAULT:@SECLEVEL=0`. (reported, S1; the adapter's TLS stack may need a different setting)

### Login

- Username and password come from the decrypted credential blob (see above). (reported)
- MQTT client identifier, keepalive, clean-session flag and QoS levels are not documented in S1.
  (unverified gap)

### Topic layout

Publish (client to printer):

```text
anycubic/anycubicCloud/v1/{slicer|web}/printer/<modeId>/<deviceId>/<type>
```

Subscribe (printer's public broadcast):

```text
anycubic/anycubicCloud/v1/{slicer|web}/printer/public/<modeId>/<deviceId>/#
```

- `{slicer|web}` selects the client kind. S1 states that the Workbench messages (see
  [Print Assist and printer details](#print-assist-and-printer-details-not-verified)) are sent on the
  `web` path. S1 does not state the path for the other messages. Treat the path of every other
  message as `not verified` until a capture shows it. (unverified gap)
- The ack and report topics are described below. S1 names the ack topic only as
  `<deviceId>/response`. The exact full path is an unverified gap.

### Message types

Types in S1 (`<type>` in the topic): `info`, `status`, `print`, `tempature` (the printer's own
spelling), `multiColorBox`, `light`, `fan`, `file`, `axis`, `skip`, `video`.

- S1 reports no raw G-code console channel. Its console is a log of the
  client's own requests, responses and printer state changes.
- These types are named in S1. Per-message status is given in each section below.
- `properties` is named only in S1's Workbench table. (reported, `not verified`)

Request envelope fields used in S1 (observed):

| Field    | Meaning                                                                  |
| -------- | ------------------------------------------------------------------------ |
| `msgid`  | Request identifier. The printer's own reports carry a different `msgid`. |
| `action` | Action name, e.g. `query`, `start`, `move`, `set`.                       |
| `type`   | Message type (see above).                                                |
| `data`   | Payload object. Shape depends on the action.                             |

## Requests, acknowledgements and outcomes

Observed on firmware 2.0.2.8 (S1):

- Every request is acknowledged at once on `<deviceId>/response` with an empty `type` and empty
  `action`, `code` 0, and the request's `msgid`. The ack means "received" only.
- The answer arrives later on `<type>/report`, with a `msgid` chosen by the printer, `code` 200,
  `state` `done` or `success`, and the request's `action`.
- `info/query` is answered with action `report`.
- The report topic is shared with other MQTT clients, and the Connector ignores retained reports.
  A report settles a request only when it carries the request's own `msgid`, `type` and `action`
  (`reportIdentity: 'exact'`, the default). A report for another client's request, an empty `msgid`
  or a retained replay never settles it.
- Source S1 observed firmware 2.0.2.8 answering with a printer-chosen `msgid`. No hardware report in
  this repository shows either behavior for a command, so exact matching stays the default and
  fails closed: the request ends as `received` or `unanswered`. For firmware that replaces or omits
  report ids, a printer qualified for it may carry `"reportIdentity": "printer-assigned"` in its
  row of `kobra-x-bindings.json`. Onboarding never writes it, and the signed control driver passes
  it only for that printer. A report then
  also settles a request when the printer acknowledged that request's `msgid`, the `type` and
  `action` match, the report's `msgid` is empty or none this connection issued, no other request
  (acknowledged or not) waits on the same `type` and `action`, and no request on them ended without
  a result in the last 30 s, since its report may still arrive. A report that fits and came from
  another client cannot be told apart, so this mode is opt-in. A report settled this way is never
  evidence that the command took effect: the outcome stays uncorrelated, and a control is confirmed
  only by fresh state read back after the write. Light and idle fan commands have no read-back
  query, so on such a printer they end unconfirmed. Readiness still needs the printer to echo the
  IDs of the state queries: firmware that replaces those too gets no command written at all.
- Control readiness is stricter than outcomes. A printer state counts as current only when the
  reply echoes the `msgid` of the latest `info` query. A busy `info` reply is current only after the
  latest `print` query was answered with a successful reply that names a job phase (`printing`,
  `paused`, a preparation phase, `finished` or `stoped`). A reply without a phase proves nothing;
  the next valid `print` reply restores readiness.

Three outcomes of a request:

| Outcome                 | Meaning                                                          | Example                                          |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| Confirmed               | A successful report arrives.                                     | `print/start` answered with a success report.    |
| Refused                 | A report with `state` `failed`, or a `code` other than 0 or 200. | `print` error with code 10111 (see jobs).        |
| Received without result | Only the ack arrived.                                            | `print/query` on an idle printer. (observed, S1) |

Multiple clients: observed on firmware 2.0.2.8 (S1). Two MQTT sessions coexisted: another client
(Kobralink) stayed connected the whole time, and each client sees reports caused by the other. The
adapter must therefore not assume it is the only reader of the report topics. S1 keeps one
connection per printer on its side.

The Connector ignores MQTT reports carrying the retained flag and requests
fresh state before permitting a signed command.

### Result window and advertised controls

A signed Kobra X command can take longer than the dispatcher's default
five-second result deadline: the request's own result wait (5 s), `start_print`'s
1.5 s watch for the printer ending the task itself, and one 3 s wait for fresh
state. The Connector therefore gives these actions a bounded result window
counted from the write (`kobraXResultWindowMs`, at most 24 s). Waits before the
write never count, and a command not yet written is never uncertain. The
state-freshness limit (2 s between the effect and the confirming state) still
applies, so a late state answer ends as `state-unconfirmed`. An uncertain outcome
stays uncertain, blocks later commands on that printer and is never retried.

A report observer that throws cannot skip settlement: the observer is called
before the waiting request is settled, and its failure is reported through
`onError` only.

Advertised controls follow evidence from the printer's own reports: the ACE
(`load_filament`, `unload_filament`) once a box with id 0 to 3 is reported, the
light (`set_light`) once the chamber light is reported, and the fan (`set_fan`)
once the part fan speed is reported. Until evidence exists, or once the printer is
unreachable, only `pause`, `resume`, `cancel`, `set_temperature` and
`start_print` are offered. After 30 s without a report the evidence is withdrawn until a newer
report arrives. A full `info/report` (one that names `state`) without the light or the fan speed
withdraws that one on the same connection. The status collection publishes the evidence and the
advertisement is refreshed when it changes.

## Status and reports

### `info/report`

- `state` is only `free` or `busy`. (observed)
- `project` is null when idle and a dictionary during a job. (observed)
- `last_project` is not updated for LAN jobs. (observed)
- `features` holds `*_support` booleans. The option list in
  [Print options](#print-options-task_settings) depends on these. (observed)
- `urls.rtspUrl` is in fact an HTTP-FLV URL (see [Camera](#camera)). (observed)

### `multiColorBox/report` (ACE box)

Box fields (observed):

| Field           | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `auto_feed`     | Auto-feed state.                                                   |
| `drying_status` | Object with `status`, `target_temp`, `duration` and `remain_time`. |
| `humidity`      | Box humidity.                                                      |
| `temp`          | Box temperature.                                                   |
| `loaded_slot`   | Currently loaded slot.                                             |
| `model_id`      | Box model identifier.                                              |

- `drying_status.remain_time` counts minutes. (observed, measured in S1)
- `drying_status.duration` reported as 86400 is not used by S1 for display. Its meaning is unverified.

Slot fields (observed):

| Field                 | Meaning                     |
| --------------------- | --------------------------- |
| `brand_name`          | Filament brand.             |
| `color`               | Slot colour.                |
| `consumables_percent` | Remaining material percent. |
| `material_name`       | Material name.              |
| `status`              | Slot status.                |
| `type`                | Material type.              |
| `weight`              | Spool weight.               |

### `file/report`

- `listLocal` timestamps are in milliseconds. (observed)
- `fileDetails` data is `{root, filename, file_details{...}}`. Other clients poll the same topic, so
  the adapter must match the reply to the file it asked about. (observed)

## Printing

### Upload and start

1. Upload the G-code file with `POST /gcode_upload` (see above). (observed)
2. Start with MQTT `print/start`. (observed)

### `print/start` fields

Observed on firmware 2.0.2.8 (S1):

<!-- prettier-ignore-start -->
| Field | Value | Note |
|---|---|---|
| `filepath` | `/` | Must be the folder `/`. |
| `filename` | the uploaded name | Given separately from `filepath`. |
| `taskid` | `"-1"` | For LAN jobs. |
| `ams_settings.ams_box_mapping` | filament-to-slot mapping | Chosen in the slicer's print dialog. |
| `task_settings` | object of print options | See the table below. |
<!-- prettier-ignore-end -->

Each mapping entry contains the slicer's `paint_index` and the printer's
`ams_index`. The reported holder uses box id `-1`, with indices 0–2 when an
ACE is attached. The first ACE uses box id 0 and indices 4–7. The reported
formula for multiple ACE units is `4 + unit * 4 + slot` when the holder is
present. S1 independently read back index 4 for the first ACE's first slot.
An ACE-only report is ambiguous: the references give indices 0–3 for a
single unit, while S1 saw the same readback of 4 on a printer that reported
only box 0. Signed explicit print mapping requires a reported holder.

Important: `filepath` set to `/<name>` makes the printer end the task with code 10111
("abnormal end of task") about one second after the start. (observed, S1) A start report alone is
not proof that the print runs. The adapter must watch `print/report` for a few seconds after the
start before it treats the job as running.

### Print options (`task_settings`)

| Option                 | Field                                              | Source                                           | Status                                   |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| Auto-leveling          | `auto_leveling` 0 or 1                             | S2, S3                                           | observed (verified by S1 on the printer) |
| Vibration compensation | `vibration_compensation` 0 or 1                    | S2, S3                                           | sent; effect not checked (S1)            |
| Flow calibration       | `flow_calibration` 0 or 1                          | S4                                               | not verified (not yet tried, S1)         |
| Time-lapse             | `timelapse` `{status: 0 or 1, count: 0, type: 64}` | `timelapse` field from S4; `type` 64 from S2, S3 | not verified (not yet tried, S1)         |

- The printer echoes `bed_leveling`, `flow_calibration` and `time_lapse` in `buried/report` with
  action `PrintStart`. A test print can confirm them. (reported, S1; the echo itself not verified)
- The adapter should drop an option that `info/report` `features` marks unsupported. For example,
  `flow_calibration_support` and `camera_timelapse_support`. (reported, S1)

### Job phases

During a job, the printer reports its phase on `print/report` with action `start`. Values
(observed, S1):

`checking`, `printing`, `hotbed_heating`, `nozzle_heating`, `ace_filament_unfeeding`,
`ace_filament_feeding`, `nozzle_purging`, `nozzle_wiping`, `nozzle_cooling`, `auto_leveling`,
`z_offset_calibrating`, `frequency_sweeping`, `hotbed_cooling_off`, `nozzle_cooling_off`,
`finished`.

- Every phase except `printing` is preparation. During preparation the printer may report 0 for
  progress, layer and time. The adapter keeps the last values and shows the job as printing. (observed)
- `print/report` with action `getSliceParam` answers another client. It is not a job state. (observed)
- A job the printer ends itself reports `stoped` with a code other than 0 or 200 (for example
  10111). That is an error. `stoped` with code 200 is a cancel. (observed, S1)
- Preparation took about 11 minutes before the first layer for a 5 minute print, cycling all four
  ACE slots twice. S1 believes this is firmware behaviour and does not confirm it. (observed,
  unconfirmed cause)

## Remaining commands

| Command       | Message and data                                                               | Status                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Home all axes | `axis/move` with `{axis: 5, move_type: 2}`                                     | observed. Answers only when finished, after about 23 to 41 s. `info` state is `busy` meanwhile.                                                        |
| Jog           | `axis/move`: `axis` 1 = X, 2 = Y, 3 = Z; `move_type` 1 = plus, 0 = minus       | observed                                                                                                                                               |
| Idle heating  | `tempature/set` with `type` 2 and `target_nozzle_temp` or `target_hotbed_temp` | observed                                                                                                                                               |
| Camera light  | `light/control` with `{type: 3, status, brightness}`; brightness 100 on, 0 off | sent as Anycubic Slicer Next sends it (S4, reported); the field values are reported in S1                                                              |
| Fan speed     | `fan/setSpeed`                                                                 | reported in S1; no answer captured. An accompanying `print/update` with `{taskid, settings: {fan_speed_pct}}` applies it during a print. Not verified. |

Commands named in S1 that are not yet verified on the printer are listed in
[Unverified items](#unverified-items).

## Time-lapse videos

| Message            | Data                                                    | Status       |
| ------------------ | ------------------------------------------------------- | ------------ |
| `file/listVideo`   | `{page_num: 1, page_size: 200, path: "/", keyword: ""}` | observed     |
| `file/deleteVideo` | `{path: "/", filename}`                                 | not verified |

`listVideo` is answered on `file/report` with action `listVideo`, `code` 200 and `data.records`, one
record per video. Record fields (observed):

| Field            | Meaning                                      |
| ---------------- | -------------------------------------------- |
| `filename`       | Video file name.                             |
| `main_file_name` | The print the video belongs to.              |
| `createTime`     | Unix seconds. `listLocal` uses milliseconds. |
| `duration`       | Seconds.                                     |
| `fileSize`       | Bytes.                                       |
| `fileKey`        | Key of the file.                             |
| `file_image`     | Name of a cover picture on the printer.      |

- A print stopped before its first frame leaves a record with `duration` 0 and about 156 bytes.
  (observed)
- No LAN route to fetch a video or its cover is known. Listing and deletion only. (S1)
- `deleteVideo` takes the folder `path` and the `filename`, as in a batch entry. Its answer has not
  been captured. S1 accepts a `file/report` with action `deleteVideo` and code 0 or 200 as success;
  that acceptance rule is not verified. (not verified)
- Both messages are sent while idle and while printing. (S1)

## Camera

- The stream URL is announced in `info/report` as `urls.rtspUrl`. (observed)
- On firmware 2.0.2.8 it is an HTTP-FLV URL of the form `http://<printer-ip>:18088/live/<token>`.
  It plays without `video/startCapture`. (observed)
- `video/startCapture` asks the printer to start the stream over MQTT. Its effect when the URL is
  already live is not documented in S1. (not verified beyond the start flow)
- The scheme of the URL (`http`, `https` or `rtsp`) decides how the client plays it. (reported, S1)
- Playing the stream needs `ffmpeg` on the client. (S1)

### Connector support and capture limits

A local camera entry can select a known always-live HTTP-FLV endpoint with
`source.kind: kobra-x-flv`, the printer's literal LAN IPv4 address, port
`18088`, and an exact `/flv` or `/live/<token>` path. Its `helper` is the
absolute path and SHA-256 of the local FFmpeg executable. Keep this file
private, especially when the path contains a token. The Connector reads the
configured endpoint once per authorized WebRTC admission. Revocation closes
the HTTP reader and FFmpeg. Browser signalling, status, and media use the
camera and assignment IDs, with the source URL confined to the Connector.

For capture-gated firmware, published integrations report
`video/startCapture` and `video/stopCapture` on
`anycubic/anycubicCloud/v1/web/printer/<modeId>/<deviceId>/video` with
`data: null`. Start reports can carry the stream URL in `data.urls.rtspUrl`
and are shared by clients of that printer. An MQTT acknowledgement identifies
receipt only. Reports can carry a firmware-generated ID, and later info
reports can mirror another client's URL. Topic, timing, action, success state,
and a well-formed token cannot establish ownership. The observed stop command
has no proven per-capture selector and may stop another client's stream.

The Connector leaves capture-gated cameras disabled. It publishes neither
start nor stop, including during cleanup or reconnect. Enabling the capability
requires a confirmed request-to-capture binding and a stop operation scoped to
that capture. Any future published start or stop without a scoped result must
leave the outcome uncertain and block replay. The loopback fixture exercises
the ambiguous broadcast and global stop behavior without qualifying firmware.

## Print Assist and printer details (not verified)

The messages below come from S4's Workbench page (its web bundle, `libWorkbench`). They are sent on
the `web` topic. S1 states that none of these answers has been captured from a Kobra X.

| Message                | Data                                      | Answer read                                                                                                                                                  | Status       |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `info/net`             | `{}`                                      | `info/report` field `mac` or `machine_mac`                                                                                                                   | not verified |
| `info/statistic-query` | none                                      | `info/report` fields `print_total_minutes`, `print_count`, `material_used_gram_value` or `material_used_value` (grams). Also pushed as `statistic-reported`. | not verified |
| `info/setPrinterName`  | `{printerName}`                           | `info/report` action `setPrinterName`                                                                                                                        | not verified |
| `properties/read`      | `["assistant_settings"]`                  | `properties/report` with `assistant_settings: [{option, value}]`                                                                                             | not verified |
| `properties/write`     | `{assistant_settings: [{option, value}]}` | `properties/report` with action `write`                                                                                                                      | not verified |

- Print Assist option numbers, from S4: 0 belt detection, 1 lost-step recovery, 3 filament break
  alert, 4 filament jam alert, 5 remaining filament detection. An option missing from the answer is
  not supported. (reported)
- Auto-feed is written with `multiColorBox/setAutoFeed`, one message per ACE box. (reported)
- S1 reports that the three reads were sent only while idle and once per connection, and that a
  write is settled only by a matching report action. The periodic `info/report` and other clients'
  answers share the topics, so the match must check the action. (reported, S1)

## Verified and unverified

### Verified on firmware 2.0.2.8 (observed)

Checked by the source owner through the service layer, outside any slicer:

- Certificate search and credentials (see TLS above).
- Connect, status and ACE slots.
- File list, details, upload and delete.
- Light.
- Camera stream URL.
- Home and jog.
- Idle heating.
- Print from a `.3mf` with a slot mapping.
- Finish detection.
- Filament usage tracking of the job.
- Time-lapse listing (`file/listVideo`).

Firmware version scope: 2.0.2.8 only. Statements about other firmware are not made here.

### Unverified items

The adapter must not depend on these until a capture exists. Each is also marked in its section.

- Pause, resume, stop.
- Filament feed and retract.
- Drying start and stop.
- Slot edit.
- Skip objects.
- Speed mode.
- Spoolman booking.
- Flow calibration and time-lapse in `print/start`.
- Everything under [Print Assist and printer details](#print-assist-and-printer-details-not-verified).
- `file/deleteVideo`.
- The hardware response to a bad signature or stale timestamp, timestamp tolerance,
  and the meaning of `did`. The Connector uses the documented literal and rejects
  a failed request without trying alternate formats.
- The canonical public MQTT topic variant and client-certificate behavior beyond
  the documented operator-provided identity. The Connector keeps its existing
  status subscription and TLS policy, with no legacy cipher fallback.
- Credential recovery on firmware other than 2.0.2.8.
- The source of the upload `s` token. Credential recovery does not enable native uploads.
- The multipart field name for `gcode_upload`.
- The MQTT client identifier, keepalive, clean-session and QoS settings.
- The exact full topic of the ack and report paths.
- The `{slicer|web}` path to use for each message.
- Behaviour inside OrcaSlicer (not part of this protocol).

## Security notes

- Discovery replies are untrusted. Use only the address that answered, and confirm it with `GET /info`
  before using it (see Candidate filtering).
- The credential blob and the MQTT credentials are secrets. Do not log them and do not commit them.
- Client certificates and keys for the shared Anycubic identity are not part of OpenFarm. Obtaining
  them is a user action, and they must not be committed.
- The printer's server certificate is self-signed. Verification or pinning is a decision for the
  adapter, not this document.
- Commands that move the printer, heat it, or start a job are physical actions. The adapter must
  gate them under OpenFarm's own authorization rules.

## Sources

- S1: kobracontrol protocol notes, owner-provided, `docs/protocol.md`. Credits as given there:
  Kobralink and KX-Bridge. Used for the observations and the verified and unverified lists in this
  document.
- S2: Kobralink, `packages/kobra-protocol` (GPL-3.0). Reported facts only, as summarized in S1.
- S3: KX-Bridge (GPL-3.0). Reported facts only, as summarized in S1.
- S4: Anycubic Slicer Next 1.x and 2.0.0.3, strings in the slicer's binaries (Anycubic proprietary).
  Reported facts only, as summarized in S1. No binary content is reproduced here.
- S5: anycubic-orca-plugin, `anycubic_lan.py` (AGPL-3.0). Reported facts only, as summarized in S1.

- S6: [Owner clean-room follow-up and synthetic vectors](https://github.com/bloodf/Open3DFarmManager/issues/363#issuecomment-6996775853).

This document also draws on S7 and S8 for camera behavior.

- S7: [stribor/anycubic_kobrax at 34955343](https://github.com/stribor/anycubic_kobrax/tree/34955343)
  (MIT). Web camera commands and tokenized FLV URLs.

- S8: [Grunna/ha-anycubic-kobra-x-lan at db9b2a8e](https://github.com/Grunna/ha-anycubic-kobra-x-lan/tree/db9b2a8e)
  (MIT). Web topic and capture sequencing.

S2, S3, S4 and S5 were not read directly for it, and no code
from any source was copied. Facts that S1 attributes to those sources are restated here in OpenFarm's
own words and stay `reported` until a Kobra X capture confirms them.
