# Anycubic LAN

Experimental read-only MQTT/TLS subscriber. Not proven on hardware (Kobra 3/S1/4).
Supply previously obtained LAN credentials and model/device identifier as serial
(e.g. 20024/device-id). Certificate validation or an exact SHA-256 pin is required.
No status request or other MQTT PUBLISH is sent; firmware requiring polling may
therefore provide no observations. Missing fields remain absent.

Community protocol references:

- https://github.com/rvanderp3/kobra-connect/blob/main/docs/mqtt-commands.md
- https://github.com/chrisfore/anycubic_ha_local

Uses printer/public/model/device/+/report topics, including the protocol spelling
`tempature`. Decoder supports numeric Celsius and partial reports. Firmware field
variants and numeric state codes need captured fixtures before qualification.
No HTTP handshake or command fallback is implemented.

## Remaining print time

Simulator-only coverage for the generic Anycubic LAN adapter. The adapter reads
`remain_time` in minutes from a print report or its `project` object. A valid
direct value takes precedence, including zero. If the direct value is invalid,
the adapter can use a valid project value from the same report.

The adapter publishes an estimate for printing and paused jobs. A partial
report with no phase or estimate can carry forward a fresh estimate.
Preparation, stopped, and unrecognized phases withdraw the estimate until
printing or paused is reported again. These phases leave the job outcome
unresolved. An explicit `error` still records a failed job following an active
job.

The Anycubic LAN simulator covers phase transitions, partial updates, active
zero, and terminal outcomes. The browser journey exercises the estimate over
direct WebRTC. The native Kobra X simulator suite separately exercises
preparation and the `stoped` report codes for cancellation and failure.
Hardware and firmware behavior for the estimate remains unqualified.
