# HALOT resin driver evidence

Sources read on 2026-11-26. Simulator results are not hardware evidence. OpenFarm has run nothing on a printer. Every HALOT catalog row stays unqualified.

The wire protocol, its sources (H1 to H9) and their conflicts are in [the protocol note](../../protocols/halot.md). GPL-3.0 clients are among the public ones; the adapter uses wire facts only and contains no third-party code. The token test vectors and the simulator's token are values published by ResinDeck (MIT, [`test_halot.cpp`](https://github.com/alexandre-pansan/ResinDeck/blob/a00595a2e9146a4e62803fc857edde0e0e392bd8/core/tests/test_halot.cpp)). No dependency was added.

## Models

HALOT BOX 4.7.0.10 (H1) lists each model below in one printer list, with the internal code shown. The printer never sends that code or the model name over this protocol, so **the model is what the owner declares**.

| Model          | HALOT BOX code | Evidence that this model speaks the protocol                                                                | OpenFarm                                                  |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| HALOT-MAGE PRO | `CL-103`       | A public client and dashboard written for it (H2, H3). Creality describes LAN printing from HALOT BOX (M1). | Read-only status; writes unqualified                      |
| HALOT-MAGE S   | `R006`         | A public tool for a rooted unit polls status on port 18188 (H8). Listed in HALOT BOX (H1).                  | Read-only status; writes unqualified                      |
| HALOT-X1       | `R009`         | Vendor only: H1, and M3 names HALOT BOX. No public client, capture or user report of success.               | Read-only status, **weaker evidence**; writes unqualified |
| HALOT-X1 Max   | `R012`         | Vendor only: H1, whose 4.7.0.10 release notes add this model (M5), and M4 names HALOT BOX.                  | Read-only status, **weaker evidence**; writes unqualified |

"Read-only status" means the Connector will try the protocol. It requires the `{"version":"1"}` reply before it sends a token, so a printer that speaks something else yields no reading.

| Key | Source                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | [HALOT-MAGE PRO product page](https://www.creality.com/products/halot-mage-pro-3d-printer): LAN printing from a PC with HALOT BOX, over Wi-Fi or Ethernet.                                             |
| M2  | [HALOT-MAGE S product page](https://www.creality.com/products/creality-halot-mage-s): file transfer by USB, Ethernet or Wi-Fi; slicing in HALOT BOX. No LAN control statement.                         |
| M3  | [HALOT-X1 product page](https://www.creality.com/products/halot-x1): data over USB or Wi-Fi 2.4 GHz; slicing in HALOT BOX or Chitu Box. No LAN control statement.                                      |
| M4  | [HALOT-X1 Max product page](https://www.creality.com/products/halot-x1-max): USB and Wi-Fi 2.4/5 GHz; slicing in HALOT BOX, CHITUBOX or Lychee; "CreFarm OS" fleet management, with no protocol given. |
| M5  | [HALOT BOX 4.7.0.10 release record](https://github.com/SpecterShell/Dumplings/tree/main/Tasks/Creality.HALOTBOX), which mirrors Creality's notes: "Added support for HALOT-X1 Neo and HALOT-X1 Max".   |

## Gaps

Every model:

- No response was captured by OpenFarm. All formats come from public clients and static analysis.
- No reply identifies the model, serial number or firmware. A wrong address with the same password would be shown under the declared model.
- Discovery is not implemented: the datagram is not established. Set-up is by IP address in the runtime file; there is no browser set-up form.
- `PRINT_STOP` means paused in some sources and stopped in another.
- No temperatures, resin level or camera. H2 gives an `rtsp://<ip>/ch0_0` camera address for the MAGE PRO, which OpenFarm does not use.
- A refused password shows only as an unavailable printer.
- The token can be reversed by anyone who watches the LAN.

By model:

- **HALOT-MAGE PRO**: H2 appends the constant block for 5 to 7 character passwords, while other sources do not. Both forms are tried.
- **HALOT-MAGE S**: H8 needed a rooted firmware for file transfer; it does not say status needs it, and no source shows status on stock firmware.
- **HALOT-X1**: one user reported that Creality-Control (H7) did "not work on Halot X1 Combo", with no detail ([comment, 2026-08-10](https://github.com/SiloCityLabs/Creality-Control/issues/1)). A search summary of Creality's X1 firmware notes says a 2025-09-24 release removed the password for the wireless link to HALOT BOX; the page did not render, so the note was not read. If so, what token such firmware expects is unknown. OpenFarm still requires a password in its file.
- **HALOT-X1 Max**: the same questions are open; no public report exists either way.

## Operations

| Operation      | Evidence                               | Connector behavior                                                                                                                     |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Status         | H1, H2, H4, H5                         | Poll every second. State, file name, layers, progress and remaining time.                                                              |
| Pause, resume  | H2, H4, H5, H7 (`PRINT_PAUSE` toggles) | Not qualified. With a qualification: sent once, only from the matching state and for the job seen at preparation; confirmed by status. |
| Stop           | H2, H4, H5, H7                         | Not qualified. With a qualification: sent once for an active job; confirmed only by `PRINT_END` or `PRINT_GENERAL`.                    |
| Upload         | H4, H5, H6                             | Not implemented: H5 finds it deletes files already on the printer, and sources disagree on its replies.                                |
| Start          | H4, H8                                 | Not implemented: no validated resin file format in OpenFarm, and H5 finds no direct start in the CL-60 handler.                        |
| Print settings | H2, H5                                 | Not implemented.                                                                                                                       |

`HALOT_QUALIFIED_WRITES` in `packages/connector/src/halot/qualification.ts` is empty. Neither the runtime file nor the wire can add an entry. An unconfirmed write blocks every later one to that printer until the Connector restarts, because a late pause followed by another would resume the job.

## What owner hardware must show before a write is qualified

1. Which token form the printer accepts, and its firmware version.
2. The `printStatus` words after pause, resume and stop. A resume or stop confirmation that never arrives leaves the command uncertain.
3. That `PRINT_PAUSE` on a paused job resumes it, and does nothing on an idle printer.

## Simulator

`packages/sim-tools/src/halot-simulator.ts` implements the version reply, the token check, status, the pause toggle and stop. Its state transitions are synthetic, including stop leading to `PRINT_END`. It implements no upload or start.

- `tests/node/halot-protocol.test.ts`: tokens, session, status words, configuration, loss and recovery.
- `tests/node/halot-runtime.test.ts`: empty list, guarded writes, runtime file.
- `tests/journey/halot.spec.ts`: browser read-only status with loss and recovery; with a test-only qualification, signed pause, resume and cancel.
