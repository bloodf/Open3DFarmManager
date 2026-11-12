# Hardware acceptance checklist (owner-run)

This checklist is the last item of issue #9. The owner runs it by hand, against real Klipper/Moonraker printers on a private LAN. It is never automated, and no test in this repository sends a command to a physical printer.

## Before you start: gates

Do not start this checklist until all of the following are true:

- [ ] **Simulator and browser acceptance passed.** The simulator and browser end-to-end gates recorded in [PHASE-0.md](PHASE-0.md) pass for the commit under test: login, pairing, farm view, signed simulated pause, outage and recovery. Simulator, fake Moonraker and HTTPS fixture results do not replace this checklist, and this checklist does not replace them.
- [ ] **The owner explicitly authorized physical tests** for this run, in writing, naming the printers, the date, and who is present. Without that authorization, stop here.
- [ ] **Two printers are available** for the full run. Several steps (5, 6, 7, 8.3 and 9) compare a controlled printer with an uncontrolled one. With only one printer, mark those comparison steps **N/A** in the results table. N/A is not a pass, and the run then counts as a partial acceptance.

Write private hostnames, addresses, account names, tokens and credential files only in the private evidence location (section 15), never in this repository, an issue or a pull request. Wherever this document shows a placeholder such as `<farm-origin>`, substitute your own value privately.

UI text is pt-BR. Exact on-screen strings are quoted as they appear, with an English gloss where it helps.

## 0. Safety rules for the whole run

Read these before any step that can heat, move or stop a printer.

**From section 5 step 4 onward** (the first heater or motion step), every step that heats or moves a printer requires all of the following:

- **Someone is physically at the printer**, with a clear view of the toolhead and bed.
- **An emergency stop is within reach.** Prefer the printer's power switch or a hardware or firmware E-stop button.
  - `M112` from Mainsail/Fluidd also works, but it halts Klipper. Klipper then needs a `FIRMWARE_RESTART` before it prints again.
  - Before starting, check that Mainsail/Fluidd is reachable from a second device that is not the farm-page browser.
  - Decide in advance which stop you will use.
- **A dry or sacrificial print**, run under this supervision: a small, short, low-temperature job (for example a single-layer square in PLA) on a printer you are willing to scrap the part on. Never use a customer job or a long print.
- **Never leave a heated printer unattended.** This includes while a pause is held: Klipper keeps the heaters on after `PAUSE` until `idle_timeout` (or your macro) turns them off.
- **One printer at a time for control steps.** Live-status steps may watch several printers.
- **No automation.** Every pause is a deliberate human click and confirmation. Never script sections 8 to 12.

**Stop criteria.** Stop immediately, use the emergency stop if anything is unsafe, then follow [Rollback](#14-rollback) when any of these happens:

- Any unexpected motion or heating.
- A heater above the material's normal setpoint plus 10 °C, or above the printer's configured maximum.
- A Klipper error or shutdown.
- More than one pause for one confirmation, or a pause on the wrong printer.
- No visible pause within **10 s** of **Confirmar pausa** when the dialog reported success.
- Any pause outcome other than the expected one.

## 1. Prerequisites

| Item           | Requirement                                                                                                                                                                                                                                                                                                                                                                             | Done |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Printers       | Two Klipper printers (or one, with comparison steps N/A) with Moonraker reachable from the Connector host on the LAN. Mainsail or Fluidd works locally.                                                                                                                                                                                                                                 | ☐    |
| PAUSE macro    | On the test printer, run **PAUSE** and then **RESUME** manually from Mainsail/Fluidd during a short dry print, under section 0 supervision, before this run. Confirm the macro exists, parks the toolhead safely and resumes correctly. Record the macro's park position and whether it changes temperatures.                                                                           | ☐    |
| Spoolman       | A Spoolman instance on the LAN with at least two spools, one assigned to a printer.                                                                                                                                                                                                                                                                                                     | ☐    |
| Camera         | At least one printer with a working camera source, configured as in [CAMERA-END-TO-END-CHECKPOINT.md](CAMERA-END-TO-END-CHECKPOINT.md#configuration-opt-in).                                                                                                                                                                                                                            | ☐    |
| Server         | The farm server at `<farm-origin>` (HTTPS, valid certificate) built from the commit under test, with its database migrated to the current catalog. Pairing, browser devices, printer assignments, connector signalling, telemetry, renewal and the farm view are enabled (see [Appendix A](#appendix-a-redacted-configuration-samples)). Pause authority stays **off** until section 8. | ☐    |
| Connector host | Node 24.22.2 (`>=24.22.2 <25`), the Connector built from the same commit (`pnpm --dir packages/connector build`), and a private data directory owned by the Connector user (not group or world readable).                                                                                                                                                                               | ☐    |
| Browser        | A current Chromium-based or Firefox browser on a separate device, logged out at the start.                                                                                                                                                                                                                                                                                              | ☐    |
| Second device  | A phone or computer, other than the farm-page browser, with Mainsail/Fluidd open, for the emergency stop and local checks.                                                                                                                                                                                                                                                              | ☐    |
| Accounts       | One owner account. Optionally a second, non-owner member account for the revocation steps.                                                                                                                                                                                                                                                                                              | ☐    |
| Evidence       | A private folder for screenshots, logs and the results table (section 15).                                                                                                                                                                                                                                                                                                              | ☐    |
| Commit         | The exact commit hash under test, recorded in the results table. Also record **whether PR #141 (automatic queue lock recovery) is included** in that commit; section 11 depends on it.                                                                                                                                                                                                  | ☐    |

Record the Klipper, Moonraker, Spoolman, browser and OS versions in the results table.

**Where diagnostics appear.** `node packages/connector/dist/cli.js run …` writes one JSON object per line on standard output for every diagnostic (for example `{"kind":"pause-authority-stale","reason":"expired"}`). Errors go to standard error with a fixed pt-BR message. Redirect both to a private log file for the whole run, for example `… run … > <evidence>/connector.log 2>&1`.

## 2. Connector identity and pairing

1. On the Connector host, create the identity with `node packages/connector/dist/cli.js init-identity --data-dir <data-dir>`. Then run `identity --data-dir <data-dir>` and note the fingerprint.
2. Start pairing: `pair --server <farm-origin> --audience <pairing-audience> --data-dir <data-dir> --credential-file <data-dir>/credential.json`. The CLI prints a short code and the fingerprint.
3. In the browser, log in as owner and open **Aprovar Connector** (`/parear`). Check that the fingerprint shown is identical to the CLI fingerprint before you approve. Approve within 60 seconds of the proof.
4. Run `status --data-dir <data-dir> --credential-file <data-dir>/credential.json`. It reports a valid credential with the expected farm and agent IDs. The device token is never printed.

**Pass:** the fingerprints match, the credential file exists with mode `0600`, and `status` reports it valid.
**Fail:** any fingerprint mismatch (stop and investigate; do not approve), or a token printed anywhere.

## 3. Printer assignment and Connector configuration

1. Open **Impressoras da farm** (`/impressoras`) and register one assignment per printer key under the paired Connector.
2. Write the Connector runtime configuration from [Appendix A](#appendix-a-redacted-configuration-samples): `collection` (with `spoolman`), `assignments`, `telemetry`, read-only `signalling`, `renewal` and, if used, `camera`. Leave the `pause` section out for now. The field reference is in [CONNECTOR-AGENT-RUNTIME-CHECKPOINT.md](CONNECTOR-AGENT-RUNTIME-CHECKPOINT.md), [CONNECTOR-RTC-RUNTIME-CHECKPOINT.md](CONNECTOR-RTC-RUNTIME-CHECKPOINT.md), [SPOOLMAN-INVENTORY-CHECKPOINT.md](SPOOLMAN-INVENTORY-CHECKPOINT.md) and [CAMERA-END-TO-END-CHECKPOINT.md](CAMERA-END-TO-END-CHECKPOINT.md).

**Pass:** each assignment shows as active, with the Connector approved.

## 4. Browser device approval

1. In **Dispositivos do navegador** (`/dispositivos`), create a key for this browser and farm, then approve it as owner.
2. If you use a second account, enroll its key but do not approve it yet.

**Pass:** the approved key appears as approved, and the pending key stays pending.

## 5. Farm view and live status

1. Start the Connector: `run --config <config> --credential-file <data-dir>/credential.json --data-dir <data-dir>`, with output redirected as in section 1. Optionally add `--status-port <port>` and open `http://127.0.0.1:<port>/` on the Connector host only.
2. Open **Minha farm** (`/farm`), then select the farm and the approved device.
3. For each idle printer, check that the connection shows "Conexão direta autenticada" (authenticated direct connection), and that the state, nozzle ("Bico") and bed ("Mesa") temperatures match Mainsail/Fluidd within a few seconds.
4. **Section 0 supervision starts here.** Start the sacrificial print on one printer from Mainsail/Fluidd. Confirm the following:
   - The farm view shows "Imprimindo" (printing).
   - Progress matches Mainsail/Fluidd.
   - The data age keeps updating.
   - The other printer still shows its own idle state.
5. Use **Configurar interface local**, enter and confirm the printer's local origin, then use **Abrir interface local** to open Mainsail/Fluidd in a new tab.

**Pass:** values match the local UI, no printer shows another printer's state, and data age stays under 10 s while connected.
**Fail:** the wrong printer, stale values shown as current, or a local link that opens a different host.

## 6. Camera

1. With the camera configured, check the camera region of the printer on `/farm`. It shows "Câmera ao vivo." (camera live) and a moving image of the right printer. The other printer shows its own camera, or "Câmera indisponível." (camera unavailable) if it has none.
2. Unplug or stop the camera source. The region shows "Câmera indisponível.", and no frozen image is presented as live.
3. Restore the source and confirm that it recovers.
4. With the OS "reduce motion" setting on, the image starts only after **Mostrar imagem ao vivo**.

**Pass:** the image is from the right printer, unavailability is shown explicitly, and the camera recovers.

## 7. Spoolman inventory

1. In **Estoque de filamento** (filament stock) on `/farm`, compare the spools, remaining weight and assignments with the Spoolman UI.
2. Change a spool's remaining weight in Spoolman and confirm the farm view updates.
3. Stop Spoolman. The inventory is marked unavailable or stale, never shown as current.

**Pass:** the values match, and unavailability is explicit.

## 8. Signed pause on a real print (safety-critical)

Re-read [section 0](#0-safety-rules-for-the-whole-run). A person stays at the printer, with the emergency stop in reach, for this whole section.

1. **Enable pause for exactly one assignment.**
   - On the server, enable pause authority and the pause signalling settings ([Appendix A](#appendix-a-redacted-configuration-samples)), then restart the server.
   - In the Connector configuration, add the `pause` section with the issuer keyring, the pause signalling settings and `"control": { "assignmentId": "<assignment-id>" }`, as described in [PAUSE-RUNTIME-COMPOSITION-CHECKPOINT.md](PAUSE-RUNTIME-COMPOSITION-CHECKPOINT.md). Restart the Connector.
2. Start the sacrificial print on that printer. Wait until `/farm` shows "Imprimindo" with live data.
3. Check that **Pausar impressão** is enabled only on that printer. On the other printer it is unavailable, with a pt-BR reason under the button.
4. Click **Pausar impressão**. A dialog opens ("Pausar impressão de …"). Wait for "Autorização pronta. Confirme em até N s." (authorization ready, confirm within N s).
5. Press **Cancelar** once and confirm nothing happens to the printer. Then open the dialog again.
6. Note the clock time, then press **Confirmar pausa**. Expected:
   - The printer pauses, and the toolhead parks per your `PAUSE` macro. Mainsail/Fluidd shows the printer as paused.
   - The dialog shows "Impressão pausada. O Connector confirmou a pausa." (paused, the Connector confirmed it).
   - The farm view state changes to "Pausada".
   - Record the time from the click to the visible pause. Above 10 s is a stop criterion.
7. Close the dialog. **Pausar impressão** is now unavailable, because the printer is no longer printing.
8. **The heaters are still on.** Klipper keeps the hotend and bed at temperature after `PAUSE` until `idle_timeout` or your macro turns them off. Do not walk away. Resume or cancel the print **locally** in Mainsail/Fluidd (the farm page cannot resume), and if you cancel, let the printer cool down.
9. Record the evidence that **exactly one pause** happened, as described in section 15:
   - The journal row for this command.
   - The matching `moonraker.log` and `klippy.log` lines.

**Pass:**

- Exactly one pause, on the right printer.
- The dialog outcome matches the printer.
- No HTTP command path: the browser network panel shows only the pause authority challenge and capability requests, and the command goes over the WebRTC data channel.

**Fail:** more than one pause, a pause on the wrong printer, a "paused" outcome without a real pause, or any automatic retry. Stop and roll back.

If the dialog shows "Não foi possível confirmar se a impressora pausou…" (outcome unknown), check the printer physically and record what you see. Do not click again until you have.

> **Journal lockout.** A pause command whose journal row stays in `claimed`, `write-started` or `outcome-unknown` blocks that assignment for every later pause, **including across Connector restarts**. This is deliberate: the Connector cannot prove whether that pause reached the printer. While blocked, every new pause for that printer is rejected, and the dialog reports "Comando recusado…". Clear it only with the manual recovery procedure in [PAUSE-RUNTIME-COMPOSITION-CHECKPOINT.md](PAUSE-RUNTIME-COMPOSITION-CHECKPOINT.md#journal-lockout-and-manual-recovery), after confirming the printer's physical state, and keep the journal backup as evidence.

## 9. Disabled states and stale data

Steps 1 and 2 may be run with the printer idle or paused. Steps 3 and 4 need a **running sacrificial print under section 0 supervision**, because pause is offered only while printing.

1. _(Idle or paused.)_ Stop the Connector process. Within about 10 s, the row shows the connection as unavailable, the last observation is marked old ("Dados desatualizados…"), and **Pausar impressão** is unavailable, with a reason. Nothing is sent. Start the Connector again.
2. _(Idle or paused.)_ Select no device, or use a browser without an approved key. The reason "Pausa indisponível. Selecione um dispositivo aprovado deste navegador." is shown.
3. _(Running sacrificial print.)_ Open the dialog, then stop the Connector before confirming. The dialog fails closed with "A conexão segura foi encerrada…" or "O estado da impressora deixou de estar ao vivo…", and nothing is sent. The print continues. Start the Connector again.
4. _(Running sacrificial print.)_ Open the dialog and wait, without confirming, until the authorization expires. The dialog says the authorization expired, **Confirmar pausa** stays disabled, and nothing is sent.

**Pass:** every case is disabled with a pt-BR reason, and nothing is sent.

## 10. Offline lifetime (30 s)

The Connector accepts a pause only while the server has confirmed its cached authority within the last 30 s (see [OFFLINE-AUTHORIZATION-LIFETIME.md](OFFLINE-AUTHORIZATION-LIFETIME.md)).

1. With a sacrificial print running under section 0 supervision and the dialog closed, block the Connector host's access to `<farm-origin>`, for example with a firewall rule. Keep the LAN path to the printer working.
2. Note the time. Live status in the browser drops, because signalling needs the server.
3. Restore server access after more than 30 s. The Connector log shows `{"kind":"pause-authority-stale","reason":"expired"}`, and `<data-dir>/pause-journal/authority-audit.jsonl` has a matching line.
4. Throughout the outage the print continues: losing the server never stops a print on its own.
5. After reconnection, wait until status is live again. If the print finished, or you paused or cancelled it, **start a new sacrificial print** first. Then repeat section 8 steps 4 to 9 once. Pause works again only after the server has confirmed authority.

**Pass:** the print never stops because of the outage, the stale event is recorded, and pause works again after recovery.

## 11. Outage and recovery

1. Restart the farm server while the Connector runs and a print is in progress. The Connector keeps running, telemetry is retained, and the farm view recovers by itself after the server returns.
2. Restart the Connector with the server up. Live status and pause availability come back without re-pairing.
3. Hard kill (power loss or `kill -9`), then restart the Connector:
   - **With PR #141 in the commit** (recorded in section 1): the Connector recovers the stale `telemetry.lock` by itself and logs `queue-lock-recovered`. No manual step is needed. A manual step here is a fail.
   - **Without PR #141:** the Connector refuses to start while `telemetry.lock` remains. Follow the operator step in [CONNECTOR-OUTAGE-RECOVERY-CHECKPOINT.md](CONNECTOR-OUTAGE-RECOVERY-CHECKPOINT.md#findings-not-fixed-here): confirm no Connector process is running, then remove that exact lock file.

**Pass:** no data loss beyond the documented queue bound, no re-pairing, and the farm view recovers.

## 12. Revocation

1. **Browser device:** revoke the browser key in `/dispositivos`. On `/farm`, live status stops for that browser, and pause becomes unavailable. An open pause dialog fails closed.
2. **Assignment:** revoke the printer's assignment in `/impressoras` ("Revogar atribuição de …"). The row shows "Atribuição revogada", and pause is unavailable. To restore it, register a new assignment and update the Connector configuration.
3. **Connector:** revoke the Connector from the farm, and note the time.
   - The server rechecks Connector authority every 5 s and sends the revocation on the next recheck.
   - The documented upper bound for a Connector that misses it, for example because it is offline, is the offline authority lifetime: 30 s by default, 60 s at most.
   - Within that window, the Connector log shows `{"kind":"pause-authority-stale","reason":"revoked"}` (or `expired` if it was offline), and signalling closes.
   - A pause attempted from a still-open dialog after that point is rejected.
   - Re-pair to continue.

**Pass:** each revocation removes control within its documented window, and nothing is sent afterwards.

## 13. Lost-reply credential recovery

The Connector renews its credential before expiry when the `renewal` section is configured. If a renewal reply is lost and the local credential then expires, a restart recovers the successor the server already committed, by readback.

1. Configure `renewal` and run until at least one renewal has succeeded: the log shows `{"kind":"credential-renewed",…}`, and `status` reports the new expiry.
2. Simulate a lost reply. Use a credential that expires within a few minutes, so you do not wait hours.
   - Start a local TLS-terminating proxy in front of `<farm-origin>`, and point only the Connector at it. It must forward renewal requests but drop the response of the renewal completion request (`POST` to the renewal route).
   - Wait until the log shows the renewal attempt.
   - Stop the Connector, and leave it stopped until the old credential has expired (`status` reports it invalid).
   - Remove the proxy and point the Connector back at `<farm-origin>`.
3. Start the Connector. Expected: the log shows `{"kind":"credential-recovered",…}`, `status` reports a valid credential with a new expiry, and the Connector continues without re-pairing.
4. If the log shows `{"kind":"credential-repair-required"}` instead, nothing recoverable was committed. Re-pair (section 2) and record it.
5. Verify that only one credential is current.
   - The local credential file now holds the new token (compare `status` before and after).
   - A Connector started with a copy of the **old** credential file is refused by the server and cannot reconnect.
   - Run that check from a separate data-directory copy, then delete the copy.

**Pass:** recovery without re-pairing when a successor was committed, a clear repair-required stop otherwise, and the old credential refused after recovery.

## 14. Rollback

Use this when any step fails, a stop criterion is hit, or anything unexpected happens.

1. **Printer first.** Use the emergency stop if there is any unsafe motion or heating. Otherwise pause or cancel locally in Mainsail/Fluidd and let the printer cool down. After `M112`, run `FIRMWARE_RESTART` before printing again.
2. **Disable pause.** Remove the `control` entry, or the whole `pause` section, from the Connector configuration and restart the Connector. Disable pause authority on the server. Pause becomes unavailable on every row.
3. If the Connector's behavior is in doubt, stop the Connector process. The printers keep working through Mainsail/Fluidd.
4. If needed, revoke the Connector and browser keys from the farm (section 12).
5. Keep `<data-dir>/pause-journal/` as evidence; do not delete it. If an assignment is locked (section 8 note), follow its manual recovery procedure.
6. Return the server to the previous commit if the server is suspect.

## 15. Evidence to record

Keep everything in the private evidence location. A redacted summary goes **only** into a comment on issue #9, or a linked PR, and nowhere else.

- **Results table:** commit, whether #141 is included, versions, date, the people present, the stop method, and pass, fail or N/A with notes for each section.
- **Screenshots** of the farm view (live, stale, revoked), the pause dialog before confirmation, and each outcome. Crop the browser URL bar and any local origin.
- **The Connector log** (section 1) for the whole run.
- **Exactly one pause per confirmed attempt:**
  - The journal rows for that command: `SELECT cmd_id, assignment_id, status, finished_at FROM pause_commands WHERE cmd_id = '<cmd-id>'` against `<data-dir>/pause-journal/pause-commands.sqlite`. Exactly one row, with `status = 'applied'`.
  - The full table for the run: one `applied` row per confirmed pause, and no extra rows.
  - `authority-audit.jsonl`.
  - The `moonraker.log` line for the single `printer.print.pause` request at that time, and the `klippy.log` lines for the `PAUSE` macro. There is exactly one of each per confirmation.
- **Measured times:** click to visible pause, Connector stop to "unavailable", and server outage to stale.
- **Deviations:** any deviation, and what you did about it.

**Redact before sharing anything:**

- Host names, IP addresses and every URL: farm origin, Moonraker, Spoolman, RTSP or camera sources, and local interface origins.
- Account names, emails and IDs (farm, agent, assignment, key, command).
- Pairing codes and Connector or browser fingerprints.
- Tokens and credential files.
- Cookies, HAR files and network exports.
- Browser URL bars.

## 16. Overall pass criteria

Phase 0 hardware acceptance passes only when all of the following hold:

- The gates at the top were met.
- Sections 2 to 13 pass on the controlled printer, and sections 5 to 7 on every enrolled printer. With one printer, the comparison steps are N/A and the result is a partial acceptance.
- Every confirmed pause produced exactly one pause on the right printer, with a matching outcome and evidence (section 15).
- No pause was ever sent while a disabled reason was shown, while authority was stale, or after a revocation.
- No automatic retry happened, and no command went over HTTP.
- The print continued through every server or network outage unless a human paused it.
- No stop criterion was hit.

Anything else is a fail. Record it, roll back, and open an issue with the redacted evidence.

**Deliberately out of scope for this checklist** (not covered, so not claimed):

- Moonraker restarts and Klipper error or shutdown states during a pause.
- Multi-tool or multi-extruder printers.
- Verifying that no camera media path goes through the server.
- Production TLS and deployment hardening.

## Appendix A: redacted configuration samples

All values are placeholders. Keep the real files private, with mode `0600`.

**Connector runtime configuration** (`<config>`). Field details are in the documents linked in section 3. The `pause` section is added only in section 8. The camera `source.address` must be a literal IP address; host names are rejected. `rtc.bindAddress` is needed only when the browser reaches the Connector over the LAN instead of the same host; it widens exposure, so see the security note in [CONNECTOR-RTC-RUNTIME-CHECKPOINT.md](CONNECTOR-RTC-RUNTIME-CHECKPOINT.md#ice-bind-address-loopback-default-opt-in-lan).

```json
{
  "version": 1,
  "collection": {
    "version": 1,
    "allowedOrigins": ["http://<printer-a-host>:7125"],
    "printers": [
      { "printerKey": "<printer-a>", "origin": "http://<printer-a-host>:7125/" }
    ],
    "spoolman": {
      "origin": "http://<spoolman-host>:7912",
      "farmId": "<farm-id>",
      "serviceId": "<spoolman-service-id>"
    }
  },
  "assignments": [
    {
      "assignment_id": "<assignment-id>",
      "farm_id": "<farm-id>",
      "agent_id": "<agent-id>",
      "printer_key": "<printer-a>",
      "moonraker_origin": "http://<printer-a-host>:7125"
    }
  ],
  "telemetry": {
    "endpoint": "<farm-origin>/api/connector/telemetry",
    "audience": "<telemetry-audience>"
  },
  "signalling": {
    "endpoint": "wss://<farm-host>/api/signalling/connector",
    "origin": "<farm-origin>",
    "audience": "<signalling-audience>"
  },
  "renewal": { "audience": "<renewal-proof-audience>" },
  "rtc": { "bindAddress": "<connector-lan-ip>" },
  "camera": {
    "helper": { "path": "/abs/path/rtsp-ingest", "sha256": "<hex>" },
    "maxSessions": 1,
    "cameras": [
      {
        "cameraId": "cam-1",
        "assignmentId": "<assignment-id>",
        "source": {
          "address": "<camera-ip>",
          "port": 8554,
          "path": "/stream"
        }
      }
    ]
  },
  "pause": {
    "version": 1,
    "issuers": [
      {
        "issuer": "<pause-issuer>",
        "kid": "<pause-kid>",
        "publicKeySpki": "<base64url Ed25519 SPKI>"
      }
    ],
    "signalling": {
      "endpoint": "wss://<farm-host>/api/signalling/pause-connector",
      "origin": "<farm-origin>",
      "audience": "<pause-audience>",
      "credentialAudience": "<credential-audience>"
    },
    "control": { "assignmentId": "<assignment-id>" }
  }
}
```

**Server environment.** These are the same settings the maintained HTTPS fixture passes in `scripts/test-signalling-https.ts`; that script is the reference for the exact list. Each feature also needs its own restricted database role URL.

- Connector signalling: `NUXT_CONNECTOR_SIGNALLING_ENABLED=true`, `NUXT_CONNECTOR_SIGNALLING_ORIGIN`, `…_ISSUER`, `…_AUDIENCE`, `…_PUBLIC_KEY_REGISTRY_PATH`, `…_TOKEN_TTL_SECONDS`, `…_PROOF_TTL_MS`, `…_READER_DATABASE_URL` and `…_PROOF_DATABASE_URL`.
- Pause authority, set **only from section 8**: `NUXT_PAUSE_AUTHORITY_ENABLED=true`, `NUXT_PAUSE_AUTHORITY_DATABASE_URL`, `…_ISSUER`, `…_KID`, `…_AUDIENCE`, `…_ISSUER_KEY_PATH`, `…_ISSUER_PUBLIC_KEY_SPKI`, `…_CREDENTIAL_ISSUER` and `…_CREDENTIAL_AUDIENCE`. The Connector's `pause.issuers` and `pause.signalling` must match these values.
- Farm view: `NUXT_PUBLIC_FLAGS_FARM_VIEW=true`, plus printer assignments (`NUXT_PRINTER_ASSIGNMENTS_ENABLED`), the Connector inventory used by the Connector pages (`NUXT_CONNECTOR_INVENTORY_ENABLED` with `NUXT_CONNECTOR_INVENTORY_DATABASE_URL`) and browser devices, pairing, telemetry and renewal, each with its own `…_ENABLED` flag and database URL.
