# Static serial/firmware comparison

A read-only review on 2026-11-04 compared the exact previously tested amd64 and ARM64 images. No Docker resources were created and no upstream binary or script was executed. Anonymous GHCR manifest/configuration/layer reads were bounded and checked against their SHA-256 digests; only the small firmware-copy layer from each image was decoded in memory. Raw upstream implementation was not extracted into the repository or retained on disk.

## Verified identical artifacts

| Artifact       | Bytes  | SHA-256, identical in both images                                  |
| -------------- | ------ | ------------------------------------------------------------------ |
| `klipper.elf`  | 387672 | `a1fd3c9723d5217b534cc4876700d9931b3db22f60b1f9410a8108b5de37ddef` |
| `klipper.dict` | 10474  | `056531bf5ab68f337622fce947e5152a968593a0da39132ac7f7dc0aab86fe0a` |

Both retained firmware artifacts identify revision `ee2c6fb`, AVR ATmega644p, a 20 MHz configured clock and 250000 baud. The compressed layer digests differ, but the firmware and dictionary bytes do not. This rules out a difference in these two retained artifacts as the explanation for the observed architecture-dependent outcomes. It does not compare the compiled native emulator libraries or host scheduler behavior.

The successful ARM64 log loaded 143 MCU commands, configured 228 moves, and warned that the nominal 20 MHz MCU was running at about 2 MHz. The native amd64 full-harness log never loaded the MCU dictionary and eventually reported inability to connect. Both logged the same Klipper short revision and Python 3.11.2. The regenerated runtime `.config` is not evidence of a mismatched retained firmware binary, as explained in the [image provenance review](SIMULATOR-IMAGE-PROVENANCE.md).

## Serial boundary and remaining hypothesis

The [exact-revision host serial implementation](https://github.com/Klipper3d/klipper/blob/ee2c6fb/klippy/serialhdl.py) requests dictionary chunks and gives each identification session five seconds before disconnecting. This is an upstream internal session bound, distinct from our outer readiness deadline. The existing amd64 logs establish repeated failure to complete identification, but do not expose how many dictionary bytes arrived before each timeout.

The [exact-revision emulator driver](https://github.com/Klipper3d/klipper/blob/ee2c6fb/scripts/avrsim.py) implements serial traffic through simulated pin transitions and provides optional pacing. The pinned startup command does not enable pacing. The measured ARM64 clock warning and prior CPU throttling make emulator progress versus wall-clock identification deadlines a specific hypothesis. They do not prove this caused the amd64 failure, and do not justify increasing firmware timeouts or weakening readiness.

A useful future diagnostic would measure dictionary-byte/offset progress and elapsed wall time per identification session under controlled conditions, comparing native emulator/runtime builds. It should distinguish no traffic, corrupt traffic and valid but incomplete transfer before considering any change. Repeating the same Docker run or waiting longer at the outer gate would not answer that question. The PTY candidate remains unapproved for default integration.
