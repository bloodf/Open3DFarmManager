# Anycubic printer camera stream and capture control

Status: research notes from upstream source, read-only. No code is copied here. Each claim links to a file at a pinned commit. Items marked **uncertain** were not confirmed by running hardware or by reading a second independent implementation.

## Sources and pinned commits

| Project                                      | Commit                                                                                                                                   | License (as stated by the project)                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| chrisfore/anycubic_ha_local (Home Assistant) | [aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d](https://github.com/chrisfore/anycubic_ha_local/tree/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d) | MIT / Apache-2.0 ([LICENSE](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/LICENSE)) |
| rvanderp3/kobra-connect                      | [3edba24606d7122c4a68accd09af937ba4fdbd08](https://github.com/rvanderp3/kobra-connect/tree/3edba24606d7122c4a68accd09af937ba4fdbd08)     | MIT ([LICENSE](https://github.com/rvanderp3/kobra-connect/blob/3edba24606d7122c4a68accd09af937ba4fdbd08/LICENSE))                  |

The repositories were checked out at the commits shown above.

## Summary

Anycubic printers with built-in or add-on cameras (Kobra 3 family, Kobra 4, Kobra X, and Kobra S1 Max generation) require an explicit capture start command (`video/startCapture`) sent over the printer's control MQTT topic to activate the camera service and turn on the chamber illumination light. New-generation firmware (Kobra 4 / X) returns a per-session tokenized stream URL in response to `startCapture` (`:18088/live/<token>`), while S1-family and Kobra 3 family printers serve RTSP or HTTP FLV streams (such as `:18088/flv`). Alternatively, printers running the Rinkhals firmware overlay serve MJPEG snapshots and streams directly on port `8080`.

## Path 1: Stock Camera Capture Control & Streaming (Kobra OS / Slicer Generation)

### Capture Control Actions

- Trigger: The official client and local integrations send a control command sequence over MQTT ([commands.py L35-37](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/commands.py#L35-L37)):
  - Action type: `"video"`, action name: `"startCapture"` (`video/startCapture`).
  - To stop capture: Action type `"video"`, action name: `"stopCapture"` (`video/stopCapture`).
- Side Effect: Starting capture automatically enables the printer's chamber / camera illumination light ([camera.py](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/camera.py)).

### Stream URLs and Protocols

- Port: Typically TCP `18088` (streaming server port).
- Protocols:
  - HTTP FLV stream (`/flv` or similar endpoints).
  - RTSP stream (`rtsp://<printer-ip>:18088/...`).
  - Tokenized Live Stream: New-generation firmware (Kobra 4 / X) responds to `startCapture` with a per-session tokenized URL endpoint (`:18088/live/<token>`) captured in video reports ([coordinator.py](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/coordinator.py)).

## Path 2: Rinkhals Firmware Overlay Camera

### Overview

- Rinkhals firmware takes over the camera subsystem entirely, replacing stock capture handling. `startCapture` commands are not processed or answered by the stock service in the same way.
- Always-on Streaming: Rinkhals serves the camera feed directly on TCP port `8080` without requiring any control channel commands or turning on chamber lights automatically ([rinkhals_camera.py](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/rinkhals_camera.py)).

### Endpoints (Port 8080)

- Still Snapshot: `http://<printer-ip>:8080/?action=snapshot` ([rinkhals_camera.py L45](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/rinkhals_camera.py#L45)).
- Multipart MJPEG Stream: `http://<printer-ip>:8080/?action=stream` ([rinkhals_camera.py L46](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/rinkhals_camera.py#L46)).
