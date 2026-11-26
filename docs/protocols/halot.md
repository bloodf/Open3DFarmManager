# Creality HALOT LAN protocol

Sources read on 2026-11-26. OpenFarm has run nothing on a HALOT printer. This note records wire facts from public sources; none of their code is used and no dependency was added.

Per-model facts and gaps are in [the evidence note](../fullfarmmanager/evidence/halot.md).

## Sources

| Key | Source                                                                                                                                                                                                                                                        | What it records                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Creality [HALOT BOX 4.7.0.10 for Windows](https://file2-cdn.creality.com/file/aa7b2b265b7c3eddd1ae9aa899b0a2c0/HALOT_BOX-v4.7.0.10-win64-Release.rar), SHA-256 `62086697df3306d3c773e8a2333f6a764bf577bb9d7e69ed1822f337beb86f41`. Read statically, never run | Official client: printer list with internal codes, command names in its network library, port `18188` and `ws://` in its connection code.                            |
| H2  | [HalotMageProSharp](https://github.com/mrtska/HalotMageProSharp/tree/d616d3a8a4b0523a5fa5b70cc2696c7896aff8a3) (MIT) and its author's [write-up](https://mrtska.net/2024/01/halot-mage-pro-print-automation-inside)                                           | Client for the HALOT-MAGE PRO: URL, commands, status fields, token, password limit, command replies.                                                                 |
| H3  | [HalotMageProDashboard](https://github.com/mrtska/HalotMageProDashboard/tree/b847874522b9f218a72f4f814115e7ccf21d968c) (MIT)                                                                                                                                  | The same author's MAGE PRO dashboard: how it reads each `printStatus`.                                                                                               |
| H4  | [ResinDeck protocol note](https://github.com/alexandre-pansan/ResinDeck/blob/a00595a2e9146a4e62803fc857edde0e0e392bd8/docs/PROTOCOL.md) (MIT)                                                                                                                 | Observed on a HALOT-R6 (not a catalog model): replies, status example, token variants, wrong-password reply, upload.                                                 |
| H5  | [open-halot-one network protocol](https://github.com/Mar2ianen/open-halot-one/blob/cc07e05d3cd7b412ef1eceee24f689716d2417f1/docs/network-control-protocol.md)                                                                                                 | Static analysis of the HALOT-ONE (CL-60, not a catalog model) printer-side server, plus one accepted live status request: command enum, token check, states, upload. |
| H6  | [creality-remote-control](https://github.com/danielkucera/creality-remote-control/tree/6ff7fc95aa4db09a56fcdf43733883ce80de181e)                                                                                                                              | Browser client: token recipe, status, pause, stop, upload.                                                                                                           |
| H7  | [Creality-Control](https://github.com/SiloCityLabs/Creality-Control/tree/8e3c9a4a398dad89c61079fc3d2728916bb4dc64) (Apache-2.0)                                                                                                                               | Home Assistant client: port, token recipe, `PRINT_PAUSE` and `PRINT_STOP`.                                                                                           |
| H8  | [Halot-Mage-S-Toolkit](https://github.com/rogersstuart/Halot-Mage-S-Toolkit/tree/6aa40d8aa5fa922858f840d9fc4224c51400b670)                                                                                                                                    | Tool for a rooted HALOT-MAGE S: `ws://<ip>:18188`, `GET_PRINT_STATUS`, `START_PRINT`.                                                                                |
| H9  | [halot-one-thing](https://github.com/mwinters-stuff/halot-one-thing/tree/19e2478f46565d96d8182ec8355ad22374aacfa5) (Apache-2.0)                                                                                                                               | HALOT-ONE client with a stand-in printer. Used only as a secondary reading of state names.                                                                           |

## Transport

- Plain WebSocket at `ws://<printer-ip>:18188`, no TLS (H2, H4, H5, H6, H8). HALOT BOX builds the same address with the constant port 18188 (H1).
- Commands are JSON text frames with a top-level `cmd` (H2, H4, H5). Replies repeat `cmd`, except the version reply (H2).
- File data goes in binary frames (H4, H5).
- No request identifier appears in any source. A client can only pair a reply with the one request in flight.

## Finding a printer

HALOT BOX ships a UDP scanner (H1: a `BasicUdpScan` class with desktop and device UDP port constants in `nettrans.dll`). No source gives the datagram format, so **OpenFarm does not discover HALOT printers**. The owner configures the printer by IP address.

H1 also chooses between a "new" and an "old" protocol per printer, comparing a field with `01`. The `new` path opens the WebSocket above. What sets the field, and what the old path speaks, is not established.

## Version

`{"cmd":"VERSION_CHECK"}`, without a token, is answered `{"version":"1"}` with no `cmd` field (H2, H4). `"1"` is the only value any source records. OpenFarm requires it before it sends anything derived from the password.

The reply names no model, serial number or firmware. **The protocol offers no way to confirm which printer answered.** The model OpenFarm shows is the one the owner declared.

## Password and token

The owner sets a network password on the printer. H2 gives `Settings > Print Settings > HALOT BOX > Password`; Creality's [troubleshooting guide](https://store.creality.com/blogs/all/creality-halot-series-toubleshooting) gives `Settings > Print Settings > Camera Monitoring > Camera Password` and says the custom password is lost when the printer is turned off. Menus differ between firmware.

It is 1 to 8 ASCII characters: longer ones are accepted by the screen and then rejected as a token (H2, H4).

Every status and print command carries `token`:

1. PKCS#7-pad the password to 8-byte blocks.
2. Encrypt with single DES in ECB mode, key `a85e9d68` (ASCII).
3. Base64 the ciphertext.

This is what the CL-60 printer compares (H5) and what H6 and H7 send. Two sources send another form for longer passwords, and OpenFarm tries it once after a `TOKEN_ERROR`:

| Password length | First token            | Second token                                         |
| --------------- | ---------------------- | ---------------------------------------------------- |
| 1 to 4          | the 8-byte block       | none                                                 |
| 5 to 7          | the 8-byte block       | block followed by `AC 47 B0 02 88 15 6E 5C` (H2, H4) |
| 8               | both blocks (16 bytes) | the first block only (H4, seen from HALOT BOX)       |

The token is a fixed function of the password, with a key published in every client, sent in clear text. **Anyone who can watch the LAN can recover the password and control the printer.** Keep these printers on a trusted network and do not reuse the password.

A wrong token does not close the connection: `GET_PRINT_STATUS` answers `"printStatus":"TOKEN_ERROR"` (H4, H5).

## Commands

| `cmd`                                                   | Extra fields                     | Sources                | OpenFarm                            |
| ------------------------------------------------------- | -------------------------------- | ---------------------- | ----------------------------------- |
| `VERSION_CHECK`                                         | none                             | H1, H2, H4, H5         | Sent                                |
| `GET_PRINT_STATUS`                                      | `token`                          | H1, H2, H4, H5, H6, H8 | Sent                                |
| `PRINT_PAUSE` (pauses, or resumes)                      | `token`                          | H1, H2, H4, H5, H7     | Behind the empty qualification list |
| `PRINT_STOP`                                            | `token`                          | H1, H2, H4, H5, H7     | Behind the empty qualification list |
| `START_PRINT`                                           | `token`, `filename`              | H1, H2, H4, H5, H8     | Never sent                          |
| `START_FILE`, `START_DATA`, `CHECK_DATA`, `CANCEL_FILE` | see below                        | H1, H2, H4, H5, H6     | Never sent                          |
| `PRINT_PARA_SET`                                        | six print parameters and `token` | H1, H2, H5             | Never sent                          |

H1's network library also names `PRINT_WORKING_LIFE`, `GET_PRINTER_LIST`, `REPORT_PRINT_STATUS` and `PRINT_ERRORCODE`. No source gives their payloads, so OpenFarm ignores any such frame.

`PRINT_PAUSE` is a toggle: there is no separate resume command (H2, H4).

The replies to pause and stop do not prove an effect. H2 documents `status` values `CMD_FAIL` and `CMD_SUCCES`; H5 finds the CL-60 answering with command names in `status`. OpenFarm ignores them and confirms only from a later status reply.

## Status

```json
{
  "cmd": "GET_PRINT_STATUS",
  "printStatus": "PRINT_PROCESSING",
  "filename": "part.cxdlpv4",
  "curSliceLayer": "200",
  "sliceLayerCount": "380",
  "printRemainTime": "2700"
}
```

Values are strings (H4, H5). A field may be empty (H4). H2, H4 and H5 also record `initExposure`, `printExposure`, `delayLight`, `eleSpeed`, `bottomExposureNum`, `layerThickness`, `printHeight` and `resin`; H4 adds `camera` and `mode`. OpenFarm reads none of those. No source reports temperatures or resin level. `printRemainTime` is in seconds (H2, H4).

| `printStatus`                  | Recorded in    | OpenFarm state                                |
| ------------------------------ | -------------- | --------------------------------------------- |
| `PRINT_GENERAL`, no `filename` | H1, H2, H4, H5 | idle                                          |
| `PRINT_GENERAL` with a file    | H3             | unknown (H3 reads it as a job about to start) |
| `PRINT_PROCESSING`             | H1, H2, H4, H5 | printing                                      |
| `PRINT_COMPLETING`             | H1, H2, H4, H5 | printing                                      |
| `PRINT_PAUSE`                  | H4             | paused                                        |
| `PRINT_STOP`                   | H1, H2, H4, H5 | paused (see below)                            |
| `PRINT_STOPING` (sic)          | H1, H4, H5     | unknown, still busy                           |
| `PRINT_COMPLETE`, `PRINT_END`  | H1, H4, H5     | idle                                          |
| `PRINT_FAIL`                   | H1, H4, H5     | error                                         |
| `TOKEN_ERROR`                  | H1, H2, H4, H5 | no status; the reading is withdrawn           |
| anything else                  |                | unknown                                       |

**Conflict on `PRINT_STOP`.** H3 shows it as "paused" on the MAGE PRO, H9's stand-in printer enters it on pause, and the CL-60 state list (H5) has no `PRINT_PAUSE` at all. H4 reads it as "stopped" on the R6. OpenFarm shows it as paused, so a printer with a job on the plate is never offered as free. A model whose `PRINT_STOP` means "stopped" will look paused until the next job state.

A printing or paused reading needs both layer numbers; without them the state is unknown.

## Upload and start (not implemented)

`START_FILE` takes `filename`, `size`, `offset`, `key`; data follows in `qCompress`ed binary chunks, each acknowledged by `START_DATA`, then `CHECK_DATA` (H4, H5, H6). OpenFarm does not send any of it:

- H5 finds that the CL-60 **deletes the `.cxdlp`, `.cxline` and `.bak` files in its transfer directory** as soon as `START_FILE` arrives.
- The sources disagree on chunk size (H4, H6) and on which `checkstate` means success (H2, H4).
- The resin artifact contract has no `.cxdlp`/`.cxdlpv4` format, so a library start could not be validated anyway.
- H5 finds no direct print start in the CL-60 `START_PRINT` handler.

## Connector

Collector version 8 takes one entry per printer in `drivers`, with its origin also in `allowedOrigins` and one assignment with `"backend": "halot"`:

```json
{
  "family": "halot",
  "printerKey": "halot-1",
  "origin": "ws://192.168.1.50:18188",
  "passwordFile": "/etc/openfarm/halot-1.json",
  "simulated": false,
  "expect": { "model": "HALOT-MAGE PRO" }
}
```

The password file is private (mode `0600`) and names the same origin:

```json
{ "origin": "ws://192.168.1.50:18188", "password": "12345678" }
```

The Connector keeps one socket per printer and asks for status every second. A timeout, a closed socket, a malformed reply or a refused token withdraws the reading; it then reconnects with a new socket. After a refused token it waits 30 seconds.
