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
