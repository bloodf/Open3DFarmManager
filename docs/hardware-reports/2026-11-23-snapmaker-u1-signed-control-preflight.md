# Snapmaker U1 signed-control preflight

The November 23, 2026 run stopped before printer writes. OpenFarm had no stable live status feed for the U1. This preflight records setup and read-only observations for [#256](https://github.com/bloodf/Open3DFarmManager/issues/256).

| Check                  | Observation                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenFarm build         | Local HTTPS farm and Connector built from `b41aac6c7404a6f573471b011815ae2b1d03da6e`, the merge of [#807](https://github.com/bloodf/Open3DFarmManager/pull/807).                                                                                               |
| Pairing and assignment | The Connector enrolled with a matching fingerprint. The local owner account approved the browser key, and the farm showed the single U1 assignment.                                                                                                            |
| Printer readback       | Moonraker 2.0.0 reported Klipper `ready` and an inactive `complete` print state. All four nozzle targets and the bed target were 0 °C at preflight and again after the stop.                                                                                   |
| Direct status          | The Connector admitted the read-only peer, then repeatedly closed it with `source-unavailable`. Its local collector also reported `stale`. The signed-control listener opened. Server-side telemetry ingestion was disabled in this isolated setup.            |
| Offline slice          | OrcaSlicer 2.5.2 generated a candidate for four 5 mm PLA cubes. The G-code lists T0–T3 in order, one object at a time, with the prime tower disabled. The minimum gap between XY extrusion bounds was 125.42 mm. The physical tool mapping remains unverified. |

No upload, print, heating, motion, or signed console command was sent. Pause and resume were untested and no pause time was measured. The SV06 was outside this run. The catalog keeps the U1 controls at `simulated`.

Before resuming, establish stable live status and verify that the operator can confirm the pause from OpenFarm with the emergency stop within reach. See the [hardware acceptance checklist](../HARDWARE-ACCEPTANCE-CHECKLIST.md).
