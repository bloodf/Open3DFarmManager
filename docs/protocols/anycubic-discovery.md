# Anycubic printer discovery and LAN handshake on the LAN

Status: research notes from upstream source, read-only. No code is copied here. Each claim links to a file at a pinned commit. Items marked **uncertain** were not confirmed by running hardware or by reading a second independent implementation.

## Sources and pinned commits

| Project                                      | Commit                                                                                                                                   | License (as stated by the project)                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| chrisfore/anycubic_ha_local (Home Assistant) | [aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d](https://github.com/chrisfore/anycubic_ha_local/tree/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d) | MIT / Apache-2.0 ([LICENSE](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/LICENSE)) |
| rvanderp3/kobra-connect                      | [3edba24606d7122c4a68accd09af937ba4fdbd08](https://github.com/rvanderp3/kobra-connect/tree/3edba24606d7122c4a68accd09af937ba4fdbd08)     | MIT ([LICENSE](https://github.com/rvanderp3/kobra-connect/blob/3edba24606d7122c4a68accd09af937ba4fdbd08/LICENSE))                  |

The repositories were checked out at the commits shown above.

## Summary

Anycubic printers (Kobra 3, Kobra 3 Max, Kobra 4, Kobra X, and Kobra S1 Max generation running Kobra OS) expose local control and telemetry via TCP port `18910` and an MQTT broker. Discovery on the LAN involves locating the printer's IP address (via mDNS service discovery or manual configuration) and establishing communication through the signed LAN handshake protocol implemented in [handshake.py](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py).

## Path 1: LAN Handshake and Authentication (`GET /info` -> `POST /ctrl`)

### Transport and Port

- Port: TCP `18910`. Defined as `_INFO_PORT` in [handshake.py L55](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L55).
- Protocol: HTTP REST over plaintext TCP.

### Phase 1: `GET /info`

- Request: `GET http://<printer-ip>:18910/info`
- Response fields expected:
  - `ctrlType`: Must not be `"cloud"`. If `"cloud"`, the printer is in cloud mode and LAN mode must be enabled on the physical printer panel ([handshake.py L115-117](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L115-L117)).
  - `token`: Authentication token string used for signing the handshake.
  - `ctrlInfoUrl`: Endpoint path for the secondary handshake post request.
  - `modelId`: Printer model identifier.
  - `cn`: Printer serial number (string).
  - `usn`: Device URN containing the MAC address / UUID (parsed via regex in [handshake.py L47-52](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L47-L52)).
  - `modelName`: Human-readable model name (e.g. `"Anycubic Kobra S1 Max"`).
  - `deviceType`: Device type string (e.g. `"fdm"`).

### Phase 2: Signed `POST /ctrl`

- Signature generation function `sign(token, ts, nonce)`:
  1. `first = md5(token[:16])`
  2. `sign = md5(first + str(ts) + nonce)`
     ([handshake.py L20-23](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L20-L23)).
- Query parameters: `ts` (epoch milliseconds), `nonce` (6 random alphanumeric characters), `sign` (32-character hex digest), `did` (32-character random device ID string) ([handshake.py L128-132](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L128-L132)).
- Request URL: Constructed via `_ctrl_url` using `ctrlInfoUrl` and port `18910` ([handshake.py L181-205](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L181-L205)).
- Response parsing and AES-CBC decryption:
  - The response returns `{code: 200, data: {info: <base64_blob>, token: <local_token>}}`.
  - Decryption key: `token[16:32].encode()`.
  - Initialization Vector (IV): `local_token.encode()[:16].ljust(16, b"\0")`.
  - Algorithm: AES-128-CBC with PKCS7 unpadding ([handshake.py L26-38](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L26-L38)).
  - Decrypted JSON payload yields MQTT broker connection parameters (`broker` URL, `username`, `password`, `deviceId`) ([handshake.py L141-157](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L141-L157)).

## Model & Firmware Compatibility

- Supported: Kobra 3 series, Kobra 3 Max, Kobra 4, Kobra X, Kobra S1 Max (Kobra OS / signed handshake firmware generation).
- Unsupported / Unsigned: Older Kobra 2 firmware or legacy Anycubic printers use a different unsigned handshake mechanism not compatible with this signed flow ([handshake.py L118-121](https://github.com/chrisfore/anycubic_ha_local/blob/aa93e1fbe8b0a3ca1dafe39f7427613a3f41a38d/custom_components/anycubic/anycubic_local/handshake.py#L118-L121)).
