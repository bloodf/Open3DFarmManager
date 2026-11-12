# Hardware acceptance checklist (owner-run)

This checklist is the last item of issue #9. The owner runs it by hand, against real Klipper/Moonraker printers on a private LAN. It is never automated, and no test in this repository sends a command to a physical printer. Simulator, fake Moonraker and HTTPS fixture results do not replace it.

Write private hostnames, addresses, account names, tokens and credential files only in the private evidence location, never in this repository, an issue or a pull request. Wherever this document shows a placeholder such as `<farm-origin>`, substitute your own value privately.

UI text is pt-BR. Exact on-screen strings are quoted as they appear, with an English gloss where it helps.

## 0. Safety rules for the whole run

Read these before any step that can move or stop a printer.

- **Someone is physically at the printer** for every step from section 8 (signed pause) onward, with a clear view of the toolhead and bed.
- **An emergency stop is within reach**: the printer's power switch, a firmware E-stop button, or the `M112` emergency stop in Mainsail/Fluidd on a separate device. Confirm before starting that you know which one you will use.
- **Use a dry or sacrificial print**: a small, short, low-temperature job (for example a single-layer square in PLA) on a printer you are willing to scrap the part on. Do not run acceptance on a customer job or a long print.
- **Never leave a heated printer unattended**, including while a pause is held.
- **One printer at a time** for control steps. Live-status steps may watch several.
- **Never automate** any step in sections 8 to 12. Every pause is a deliberate human click and confirmation.
- Stop the run and use [Rollback](#14-rollback) on any unexpected motion, heating, error, or a pause outcome other than the expected one.

## 1. Prerequisites

| Item              | Requirement                                                                                                                                                                                            | Done |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| Printers          | At least one, ideally two, Klipper printers with Moonraker reachable from the Connector host on the LAN. Mainsail or Fluidd works locally.                                                             | ☐    |
| Spoolman          | A Spoolman instance on the LAN with at least two spools, one assigned to a printer.                                                                                                                    | ☐    |
| Camera            | At least one printer with a working camera source, configured for the Connector as described in [CAMERA-END-TO-END-CHECKPOINT.md](CAMERA-END-TO-END-CHECKPOINT.md).                                    | ☐    |
| Server            | The farm server at `<farm-origin>` (HTTPS, valid certificate) built from the commit under test, with its database migrated to the current catalog.                                                     | ☐    |
| Connector host    | Node 24.22.2 (`>=24.22.2 <25`), the Connector built from the same commit (`pnpm --dir packages/connector build`), and a private data directory owned by the Connector user (not group/world readable). | ☐    |
| Browser           | A current Chromium-based or Firefox browser on a separate device, logged out at the start.                                                                                                             | ☐    |
| Accounts          | One owner account. Optionally a second, non-owner member account, for the revocation steps.                                                                                                            | ☐    |
| Evidence location | A private folder for screenshots, logs and the results table (see section 15).                                                                                                                         | ☐    |
| Commit            | The exact commit hash under test, recorded in the results table.                                                                                                                                       | ☐    |

Record the Klipper, Moonraker, Spoolman, browser and OS versions in the results table.

## 2. Connector identity and pairing

1. On the Connector host, create the identity: `node packages/connector/dist/cli.js init-identity --data-dir <data-dir>`, then `identity --data-dir <data-dir>` and note the fingerprint.
2. Start pairing: `pair --server <farm-origin> --audience <pairing-audience> --data-dir <data-dir> --credential-file <data-dir>/credential.json`. The CLI prints a short code and the fingerprint.
3. In the browser, log in as owner and open **Aprovar Connector** (`/parear`). Check that the fingerprint shown is identical to the CLI fingerprint before you approve. Approve within 60 seconds of the proof.
4. `status --data-dir <data-dir> --credential-file <data-dir>/credential.json` reports a valid credential with the expected farm and agent IDs. The device token is never printed.

**Pass:** fingerprints match, the credential file exists with mode `0600`, and `status` reports it valid.
**Fail:** any fingerprint mismatch (stop and investigate; do not approve), or a token printed anywhere.

## 3. Printer assignment

1. Open **Impressoras da farm** (`/impressoras`) and register one assignment per printer key under the paired Connector.
2. Write the Connector runtime configuration (collection, assignments, telemetry and read-only `signalling`) for these printers. Leave the `pause` section out for now.

**Pass:** each assignment shows as active with the Connector approved.

## 4. Browser device approval

1. In **Dispositivos do navegador** (`/dispositivos`), create a key for this browser and farm, then approve it as owner.
2. If you use a second account, enroll its key but do not approve it yet.

**Pass:** the approved key appears as approved; the pending key stays pending.

## 5. Farm view and live status

1. Start the Connector: `run --config <config> --credential-file <data-dir>/credential.json --data-dir <data-dir>`. Optionally add `--status-port <port>` and open `http://127.0.0.1:<port>/` on the Connector host only.
2. Open **Minha farm** (`/farm`), select the farm and the approved device.
3. For each printer, check the following.
   - The connection shows "Conexão direta autenticada" (authenticated direct connection).
   - State, nozzle ("Bico") and bed ("Mesa") temperatures match Mainsail/Fluidd within a few seconds.
   - Progress during a print matches.
   - The data age updates.
4. Start the sacrificial print on one printer from Mainsail/Fluidd and confirm "Imprimindo" and progress appear.
5. Use **Configurar interface local**, enter and confirm the printer's local origin, then **Abrir interface local** to open Mainsail/Fluidd in a new tab.

**Pass:** values match the local UI; there is no state from a different printer; data age stays under 10 s while connected.
**Fail:** wrong printer, stale values shown as current, or the local link opens a different host.

## 6. Camera

1. With camera configured, check the camera region of the printer on `/farm`. It shows "Câmera ao vivo." (camera live) and a moving image matching the real printer.
2. Unplug or stop the camera source. The region shows "Câmera indisponível." (camera unavailable), and no frozen image is presented as live.
3. Restore the source and confirm it recovers.
4. With the OS "reduce motion" setting on, the image starts only after **Mostrar imagem ao vivo**.

**Pass:** the image is from the right printer, unavailability is shown explicitly, and it recovers.

## 7. Spoolman inventory

1. In **Estoque de filamento** (filament stock) on `/farm`, compare spools, remaining weight and assignment with the Spoolman UI.
2. Change a spool's remaining weight in Spoolman and confirm the farm view updates.
3. Stop Spoolman. The inventory is marked unavailable or stale, never shown as current.

**Pass:** values match, and unavailability is explicit.

## 8. Signed pause on a real print (safety-critical)

Re-read [section 0](#0-safety-rules-for-the-whole-run). A person stays at the printer with the emergency stop in reach for this whole section.

1. Enable pause for exactly one assignment. Add the `pause` section to the Connector runtime configuration with the issuer keyring, pause signalling settings and `control: { "assignmentId": "<assignment-id>" }`, as described in [PAUSE-RUNTIME-COMPOSITION-CHECKPOINT.md](PAUSE-RUNTIME-COMPOSITION-CHECKPOINT.md). Enable the pause runtime on the server. Restart the Connector.
2. Start the sacrificial print on that printer and wait until `/farm` shows "Imprimindo" with live data.
3. Check that **Pausar impressão** is enabled only on that printer. On every other printer it is unavailable, with a pt-BR reason under the button.
4. Click **Pausar impressão**. A dialog opens ("Pausar impressão de …"). Wait for "Autorização pronta. Confirme em até N s." (authorization ready, confirm within N s).
5. Press **Cancelar** once and confirm nothing happens to the printer. Open the dialog again.
6. Press **Confirmar pausa**. Expected:
   - The printer pauses (toolhead parks or stops per your Klipper `PAUSE` macro), and Mainsail/Fluidd shows paused.
   - The dialog shows "Impressão pausada. O Connector confirmou a pausa." (paused, the Connector confirmed it).
   - The farm view state changes to "Pausada".
   - Record the time from the click to the visible pause.
7. Close the dialog. Confirm **Pausar impressão** is now unavailable, because the printer is no longer printing.
8. Resume or cancel the print **locally** in Mainsail/Fluidd. The farm page cannot resume.
9. Check that nothing was retried: Moonraker's history shows exactly one pause request for this attempt.

**Pass:** exactly one pause; the dialog outcome matches the printer; no HTTP command path was used (the browser network panel shows only the pause authority challenge and capability requests, and the command over the WebRTC data channel).
**Fail:** more than one pause, a pause on the wrong printer, a "paused" outcome without a real pause, or any automatic retry. Stop and roll back.

If the dialog shows "Não foi possível confirmar se a impressora pausou…" (outcome unknown), check the printer physically and record it. Do not click again until you have.

## 9. Disabled states and stale data

Keep the print idle or paused for these checks.

1. Stop the Connector process. Within about 10 s, the row shows the connection unavailable, the last observation marked as old ("Dados desatualizados…"), and **Pausar impressão** unavailable with a reason. Nothing is sent.
2. Select no device, or use a browser without an approved key. The reason "Pausa indisponível. Selecione um dispositivo aprovado deste navegador." is shown.
3. Open the dialog, then stop the Connector before confirming. The dialog fails closed ("A conexão segura foi encerrada…" or "O estado da impressora deixou de estar ao vivo…"), and nothing is sent.
4. Open the dialog and wait without confirming until the authorization expires. The dialog shows that the authorization expired, and **Confirmar pausa** stays disabled.

**Pass:** every case is disabled with a pt-BR reason and nothing is sent.

## 10. Offline lifetime (30 s)

The Connector accepts pause only while its cached authority was confirmed by the server within the last 30 s (see [OFFLINE-AUTHORIZATION-LIFETIME.md](OFFLINE-AUTHORIZATION-LIFETIME.md)).

1. With a sacrificial print running and the dialog closed, block the Connector host's access to `<farm-origin>`, for example with a firewall rule. Keep the LAN to the printer working.
2. Note the time. Live status in the browser drops, because signalling needs the server.
3. Restore server access after more than 30 s. Confirm the Connector logs `pause-authority-stale` with `expired` and appends a line to `<data-dir>/pause-journal/authority-audit.jsonl`.
4. After reconnection, wait until status is live again, then repeat section 8 steps 4 to 6 once. Pause works again only after the server confirmed authority.
5. Throughout, the print itself continues: losing the server never stops a print on its own.

**Pass:** the print never stops because of the outage; the stale event is recorded; pause works again after recovery.

## 11. Outage and recovery

1. Restart the farm server while the Connector runs and a print is in progress. The Connector keeps running, telemetry is retained, and the farm view recovers by itself after the server returns.
2. Restart the Connector with the server up. Live status and pause availability come back without re-pairing.
3. If the Connector was killed hard (power loss, `kill -9`) and refuses to start because `telemetry.lock` remains, follow the operator step in [CONNECTOR-OUTAGE-RECOVERY-CHECKPOINT.md](CONNECTOR-OUTAGE-RECOVERY-CHECKPOINT.md): confirm no Connector process is running, then remove that exact lock file.

**Pass:** no data loss beyond the documented queue bound, no re-pairing, and the farm view recovers.

## 12. Revocation

1. **Browser device:** revoke the browser key in `/dispositivos`. On `/farm`, live status stops for that browser and pause becomes unavailable. An open pause dialog fails closed.
2. **Assignment:** revoke the printer's assignment in `/impressoras` ("Revogar atribuição de …"). The row shows "Atribuição revogada" and pause is unavailable. Restore it by registering a new assignment and updating the Connector config.
3. **Connector:** revoke the Connector from the farm. Within one 5 s server recheck, the Connector receives the revocation. Pause authority goes stale immediately (`pause-authority-stale` with `revoked`), and signalling closes. A pause attempt from a still-open dialog is rejected. Re-pair to continue.

**Pass:** each revocation removes control within seconds, and nothing is sent afterwards.

## 13. Lost-reply credential recovery

The Connector renews its credential before expiry when the `renewal` section is configured. If a renewal reply is lost and the local credential expires, a restart recovers the committed successor by readback.

1. Configure `renewal` and run until at least one renewal succeeded (`credential-renewed` diagnostic, new expiry in `status`).
2. To exercise recovery, stop the Connector right after a renewal request is sent, before the new credential is written. In practice: block the server response for one renewal. Then restart after the old credential expired.
3. On restart the Connector logs `credential-recovered` and continues without re-pairing.
4. If it logs `credential-repair-required` instead, nothing recoverable was committed. Re-pair (section 2) and record it.

**Pass:** recovery without re-pairing when a successor was committed, and a clear repair-required stop otherwise. Never two valid credentials in use.

## 14. Rollback

Use this when any step fails or anything unexpected happens.

1. **Printer first:** use the emergency stop if there is any unsafe motion or heating. Otherwise pause or cancel locally in Mainsail/Fluidd.
2. Disable pause: remove the `control` entry (or the whole `pause` section) from the Connector configuration and restart the Connector. Pause becomes unavailable on every row.
3. If the Connector's behavior is in doubt, stop the Connector process. Printers keep working through Mainsail/Fluidd.
4. If needed, revoke the Connector and browser keys from the farm (section 12).
5. Keep `<data-dir>/pause-journal/` as evidence; do not delete it. Its manual recovery procedure is in [PAUSE-RUNTIME-COMPOSITION-CHECKPOINT.md](PAUSE-RUNTIME-COMPOSITION-CHECKPOINT.md).
6. Return to the previous server commit if the server is suspect.

## 15. Evidence to record

Keep everything in the private evidence location. Publish only a redacted summary.

- The results table: commit, versions, date, and a pass or fail with notes for each section.
- Screenshots of the farm view (live, stale, revoked), the pause dialog before confirmation, and each outcome.
- Connector diagnostics output for the run, including the pause, stale, revocation and renewal events.
- The command journal outcome for each pause: `SELECT cmd_id, assignment_id, status, finished_at FROM pause_commands` from `<data-dir>/pause-journal/pause-commands.sqlite`, and `authority-audit.jsonl`.
- Moonraker history or logs showing exactly one pause per confirmed attempt.
- Measured times: click to visible pause, Connector stop to "unavailable", server outage to stale.
- Any deviation, with what you did about it.

Redact host names, IP addresses, account names, tokens and IDs before sharing.

## 16. Overall pass criteria

Phase 0 hardware acceptance passes only when all of the following hold:

- Sections 2 to 13 all pass on at least one printer, and sections 5 to 7 on every enrolled printer.
- Every confirmed pause produced exactly one pause on the right printer, with a matching outcome.
- No pause was ever sent while a disabled reason was shown, while authority was stale, or after a revocation.
- No automatic retry happened, and no command went over HTTP.
- The print continued during every server or network outage unless a human paused it.

Anything else is a fail. Record it, roll back, and open an issue with the redacted evidence.
