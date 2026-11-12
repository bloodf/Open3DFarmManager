# Farm page pause checkpoint

The farm page (`apps/farm/app/pages/farm.vue`) can now send one confirmed, signed pause for one assigned printer. The command travels only over the authenticated pause WebRTC data channel to the Connector. There is no HTTP or server command path; the only HTTP calls are the existing pause authority challenge and capability issuance.

## When the button is enabled

`pauseAvailability` (`apps/farm/app/utils/farm-pause.ts`) enables **Pausar impressão** only when all of these hold, and otherwise shows the first failing reason in pt-BR, linked with `aria-describedby`. The unavailable button uses `aria-disabled` (not `disabled`), so it stays focusable and its reason is announced; a click opens nothing:

1. `/api/signalling/pause-metadata` reports pause enabled for this exact origin.
2. The assignment is active and its Connector approved.
3. An approved device key of this browser is selected.
4. The row has a live authenticated direct connection with a current, non-historical observation. A seamless lease renewal from #121 keeps the row live, so it does not flicker the button.
5. The observation is not stale (`observationAge`).
6. The printer reports `printing`.

## Confirmation dialog

The button opens a native modal `<dialog>` (background inert, focus trapped, `Esc` closes, focus returns to the button). Opening it starts one control session (`openFarmPauseControl`, `apps/farm/app/utils/webrtc/farm-pause-control.ts`), mirroring the verified execution fixture browser composition:

- The approved local key and the pause metadata are resolved again through `createFarmStatusKeyResolver` with the pause metadata route.
- `PauseBrowserSignallingClient` opens the authenticated pause RTC session; `createPauseCommandClient` runs the admission with the HTTP issuer and signs the command with the nonextractable local key.
- **Confirmar pausa** is enabled only after the browser sent its capability and admission proof, and only while the signed capability has at least 3 s of validity left. The dialog shows the remaining seconds.
- Confirming sends exactly one command. The dialog reports the outcome: applied, rejected by the Connector, not sent, or unknown (with an instruction to check the printer). Nothing is retried; a new pause needs a new dialog and a new session.
- If no fresh capability is ready within 15 s, or the capability is already expired by this device's clock, the dialog fails closed and suggests checking the device date and time.
- A rejected command is reported neutrally ("Comando recusado"), because a rejection can come from the Connector or from a local check before sending; in both cases the printer was not paused.
- The session fails closed with an explicit reason when the key or metadata cannot be resolved, the capability expires before confirmation, the transport ends, or the row stops being live while the dialog is open. Cancel or `Esc` close it. A command in flight cannot be cancelled; the dialog waits for its outcome.

## Validation boundary

- `tests/node/farm-pause-control.test.ts`: real keys and signatures with issuer and signalling doubles. Covers one command after admission, no offer without enough capability validity, transport end before confirmation, unresolved key, cancel while ready, and every availability reason.
- `tests/e2e/farm-view.spec.ts` (opt-in `FARM_VIEW_E2E=true`): the button stays disabled with the pt-BR reason when pause is not enabled and when no approved device is selected.
- A browser end-to-end run of this page against the real HTTPS fixture (login, farm page, signed pause, applied) is not automated yet: the HTTPS fixture drives its own browser actors, not this page. The execution rows in `PAUSE-RTC-CONSUMER-CHECKPOINT.md` exercise the same browser modules against the real server and a synthetic Moonraker.

No physical printer was used.
