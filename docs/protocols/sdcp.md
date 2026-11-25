# Elegoo SDCP

The model table below describes status coverage. Print control and upload are an
experimental local opt-in, recorded in
[Elegoo evidence](../fullfarmmanager/evidence/elegoo.md).

The registered Connector uses UDP discovery with `M99999`. It accepts
flat `Data` from the matching IPv4 sender. WebSocket status requires an allowed
model and an explicit v3.0.0 identity. The adapter polls with command 0 every two
seconds while connected at `/websocket` on TCP 3030 by default. It accepts
status frames matching the board ID and status topic without requiring a command
acknowledgment or request ID. SDCP LAN traffic is unauthenticated and unencrypted.
[CBD SDCP v3 specification](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0)

The runtime exposes normalized state, valid layer counters and layer progress.
Malformed or mismatched frames do not update the snapshot. Errors, disconnects
and expiry make status unavailable. Control is disabled without the opt-in.

| Model                                 | Protocol and firmware evidence                                                                                            | Adapter coverage                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Centauri Carbon                       | Stock V1.1.46 SDCP v3. Discovery may omit the version. Uses board ID, source 1 and epoch milliseconds in requests.        | Discovery, raw job state, nozzle, bed, chamber and fan values when reported and local MJPEG URL on V1.1.46.                      |
| Saturn 4 Ultra 16K                    | Stock V1.5.6 SDCP v3. Firmware observation includes nested discovery attributes, status, history and RTSP camera control. | Discovery, raw job state, reported resin sensors, wear counters and errors, history IDs on V1.5.6. RTSP session control pending. |
| Saturn 4 Ultra (12K)                  | SDCP v3 monitoring observed by community clients. Firmware-specific qualification pending.                                | Runtime supports normalized status and layer progress when v3 is explicit.                                                       |
| Mars 5 Ultra                          | SDCP v3 monitoring reported by a community integration. Firmware-specific qualification pending.                          | Runtime supports normalized status and layer progress when v3 is explicit.                                                       |
| Saturn 3 Ultra                        | Legacy SDCP over MQTT documented by a client with device examples.                                                        | Unsupported.                                                                                                                     |
| Mars 4 Ultra                          | Community client identifies the legacy v1 MQTT family. Exact firmware coverage pending.                                   | Unsupported.                                                                                                                     |
| Jupiter 2                             | Wire protocol and firmware evidence insufficient.                                                                         | Unsupported.                                                                                                                     |
| Saturn 2 and Mars 3 Pro               | USB workflows in the catalog.                                                                                             | Unsupported.                                                                                                                     |
| Centauri Carbon 2 / 2 Combo           | Separate MQTT implementation with firmware-dependent LAN behavior.                                                        | Unsupported.                                                                                                                     |
| Neptune 4 family and OrangeStorm Giga | Klipper/Moonraker family.                                                                                                 | Outside SDCP.                                                                                                                    |

Model evidence comes from [Centauri firmware observations](https://github.com/bjan/pycentauri/blob/main/docs/PROTOCOL.md), [Saturn 16K V1.5.6 probes](https://github.com/alfiedennen/sdcp-saturn-4-ultra), [Saturn 12K monitoring client](https://github.com/jeroenwalter/SdcpMonitor), [Mars 5 Ultra integration](https://github.com/LM1LC3N7/gladys-elegoo/blob/main/docs/en.md), [legacy Saturn client](https://github.com/JacobZwang/elegoo-saturn-4-ultra), [legacy SDCP library](https://github.com/blakejrobinson/sdcp), and the [resin catalog](../fullfarmmanager/catalog-resin.md). The implementation is original. Fixtures are synthetic examples based on public wire evidence.

## Coverage gaps

Nested discovery attributes observed in Saturn 16K probes need separate
qualification. The Saturn loopback fixture uses the runtime's flat format.
Centauri V1.1.46 uses a different status shape and can omit the protocol version.
The retained Centauri fixture verifies that an explicit v3 version does not
override the model gate.

The runtime does not expose history command 320, camera, raw temperature, fan
or release-film readings, or material and resin consumption. The Saturn probes
provide firmware-specific evidence for history and RTSP. The Centauri notes
describe local MJPEG and different tick units. These observations do not
qualify any hardware through the Connector.
