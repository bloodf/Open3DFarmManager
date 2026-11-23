# Creality stock telemetry

Read-only experimental support for the stock K1/K1 Max/K1C/K2/Hi LAN
WebSocket endpoint on port 9999. **Not proven on hardware.**

The client consumes unsolicited flat JSON status objects and replies with the
text frame `ok` when it receives `{"ModeCode":"heart_beat"}`. This keepalive
comes from community protocol sources and is hardware-unqualified. The telemetry
client sends no printer commands. The WebSocket library handles control ping
and pong frames automatically.
Firmware requiring an explicit status subscription is not yet qualified.
No Cloud, HTTP fallback, RTC or collection integration is included.

Decoded fields: state (0 idle, 1 printing, 2 paused), nonzero numeric err
(error), nozzleTemp/bedTemp (actual Celsius), nozzleTemp2/bedTemp2 (targets),
printProgress (0–100 percent), print (filename), layer (integer).
Unknown states and fields remain absent. Partial frames remain partial and are
not merged. Invalid values are omitted; malformed JSON and frames above 64 KiB
are rejected. Reconnect delay doubles to a bounded cap until explicit close.

Sources consulted:

- https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/Utils/CrealityPrint.cpp
  (stock port and text WebSocket transport).
- https://github.com/ChestnutLabs/printer-protocol-orchard/blob/main/protocols/creality.md
  (flat unsolicited status field bags; source-read, not hardware qualification).

Tests use synthetic fixtures and a loopback-only simulator. Model and firmware
variants, state mappings and subscription requirements require hardware validation.
