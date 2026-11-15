# Creality printer discovery on the LAN

Status: research notes from upstream source, read-only. No code is copied here. Each claim links to a file at a pinned commit. Items marked **uncertain** were not confirmed by running hardware or by reading a second independent implementation.

## Sources and pinned commits

| Project                                        | Commit                                                                                                                                      | License (as stated by the project)                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CrealityOfficial/CrealityPrint                 | [6262848e302b8c0d593f2b341cd01310aa2f58a1](https://github.com/CrealityOfficial/CrealityPrint/tree/6262848e302b8c0d593f2b341cd01310aa2f58a1) | AGPL-3.0 (repository license file)                                                                                             |
| SiloCityLabs/Creality-Control (Home Assistant) | [8e3c9a4a398dad89c61079fc3d2728916bb4dc64](https://github.com/SiloCityLabs/Creality-Control/tree/8e3c9a4a398dad89c61079fc3d2728916bb4dc64)  | Apache-2.0 ([LICENSE](https://github.com/SiloCityLabs/Creality-Control/blob/8e3c9a4a398dad89c61079fc3d2728916bb4dc64/LICENSE)) |
| 3dg1luk43/ha_creality_ws (Home Assistant)      | [58c00818e8303a0d636bd05929cad215aed9ccb3](https://github.com/3dg1luk43/ha_creality_ws/tree/58c00818e8303a0d636bd05929cad215aed9ccb3)       | not checked                                                                                                                    |
| rathlinus/ha-creality-lan (Home Assistant)     | [0ec15420079b97b2ef2f3e0be27a9fb741fc1e50](https://github.com/rathlinus/ha-creality-lan/tree/0ec15420079b97b2ef2f3e0be27a9fb741fc1e50)      | not checked                                                                                                                    |
| hurricaneb/hass_creality_k1 (Home Assistant)   | [9c77470ee414d860b0fd72433245001b592ec3fe](https://github.com/hurricaneb/hass_creality_k1/tree/9c77470ee414d860b0fd72433245001b592ec3fe)    | not checked                                                                                                                    |

The Creality Print tree was checked out at the commit above, dated 2026-11-13. Other projects were checked at the commits shown.

## Summary

Creality Print does not discover printers with a Creality-specific UDP broadcast. It runs a DNS-SD (mDNS) service enumeration over IPv4 multicast on UDP port 5353. Printers answer with PTR records whose instance names contain a Creality marker. Each candidate IP is then confirmed with an HTTP(S) `GET /info` request, which returns JSON with the device model and MAC address.

No UDP broadcast on a Creality-specific port and no `M99999`-style G-code query was found in Creality Print for discovery. Only mDNS and the `/info` probe were found.

One Home Assistant integration (Creality-Control) discovers printers with SSDP and then confirms them over WebSocket on a short list of ports. The other three integrations checked do not contain LAN discovery code.

## Path 1: mDNS / DNS-SD enumeration (Creality Print)

### Transport

- Protocol: UDP, IPv4 multicast group 224.0.0.251, destination port 5353 (the mDNS port). The port constant is defined in [mdns.h L47](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/mdns.h#L47). The multicast destination is built at [mdns.h L871](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/mdns.h#L871). The group is joined for receiving at [mdns.h L439](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/mdns.h#L439).
- IPv6 (ff02::fb) is supported by the library code path, but the Creality discovery entry point opens IPv4 client sockets, one per interface, through `open_client_sockets`. Whether any printer answers over IPv6 was not checked.
- The library is the public-domain mdns.h by Mattias Jansson (its header says "Public Domain"). The Creality wrapper `cxmdns.cpp` is part of the Creality Print tree.

### Request

- One DNS message is sent per client socket with `mdns_discovery_send`, which calls the multicast send helper ([mdns.h L900-902](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/mdns.h#L900-L902)).
- Payload ([mdns.h L882-898](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/mdns.h#L882-L898)): transaction ID 0; flags zero (standard query); one question; zero answer, authority and additional records. The question name is `_services._dns-sd._udp.local.`, type PTR, class IN with the unicast-response bit set (QU).
- Timing: the sender transmits once per socket. There is no retransmission in this path.

### Response parsing

Implemented in [cxmdns.cpp L61-171](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/cxmdns.cpp#L61-L171):

- A response is accepted only if the transaction ID is 0 and the flags word is exactly 0x8400 (response, authoritative). Otherwise it is dropped ([L85-87](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/cxmdns.cpp#L85-L87)).
- The answer must be a PTR record. The instance name, taken from the PTR target, is matched by substring against a prefix list ([L153-163](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/cxmdns.cpp#L153-L163)).
- The source IP is taken from the socket's sender address, with the port removed ([L165-166](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/cxmdns.cpp#L165-L166)).

Prefix list used by the callers ([PrinterMgrView.cpp L2005-2008](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/App/PrinterMgrView.cpp#L2005-L2008)): `CXSWBox`, `creality`, `Creality`. A second caller with the same list is at [PrinterMgrView.cpp L2166-2169](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/App/PrinterMgrView.cpp#L2166-L2169). A third caller is in [GUI_App.cpp L9190](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/GUI_App.cpp#L9190).

The collection window is fixed. The receive loop waits on a select with a 5-second timeout and repeats while replies keep arriving ([cxmdns.cpp L220-244](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/utils/cxmdns.cpp#L220-L244)). So discovery ends 5 seconds after the last reply.

### Instance name format (legacy)

The address-correction code treats an instance name matching the regular expression `_creality` followed by two digits, four digits, and more characters as a "legacy" answer ([PrinterMgrView.cpp L2051](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/App/PrinterMgrView.cpp#L2051)). The meaning of the two groups of digits was not established. **Uncertain.** For such names the code queries `http://<ip>/info` directly, without the secure probe ([L2058-2060 region and L2082-2085 region](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/App/PrinterMgrView.cpp#L2058-L2085)).

Names beginning with `_CXSWBox` are skipped for address correction ([L2024-2026 region](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/App/PrinterMgrView.cpp#L2024-L2026)).

## Path 2: `/info` identity probe (Creality Print)

Every candidate from path 1 that is not a legacy name goes through the LAN device probe. Source: [LanDeviceProbe.cpp](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp).

### Request

- Secure source: `GET https://<ip>:443/info` ([L125-126](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp#L125-L126)). TLS verifies the peer against a bundled CA file, does not verify the host name, and ignores certificate time ([L146-152](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp#L146-L152)).
- Plain source: `GET http://<ip>:80/info`.
- Proxies are disabled for the request.
- Timeouts ([LanDeviceProbe.hpp L42-48](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.hpp#L42-L48), used at [L134-135](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp#L134-L135)): connect 3 s; HTTPS total 6 s; HTTP total 3 s. Response size limit is 64 KiB.
- Optional port pre-check ([L214-268](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp#L214-L268)): a TCP connect to 443 and 80 with a 500 ms limit. Only used when the caller enables it.

### Attempt order

The default policy is "prefer secure" ([LanDeviceProbe.hpp L15-18](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.hpp#L15-L18)). HTTPS is tried first, then HTTP if HTTPS fails ([L336-359](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp#L336-L359)). Address validation requires a numeric IPv4 address.

### Response

- HTTP status must be 200 and the body must parse as JSON ([L162-170 region](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp#L116-L176)).
- Required string fields: `model` and `mac`, both non-empty ([L86-91](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp#L86-L91)). Missing either is an invalid-info error.
- For the HTTPS source only, `wssPort` and `videoPort` are also required. Each is a number or a numeric string between 1 and 65535 ([L198-199](https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/LanDeviceProbe.cpp#L198-L199)). These are the ports for the WebSocket control channel and the camera stream.
- Other fields from the same JSON object are kept in the profile as raw data.

### Firmware and model applicability

The code does not gate discovery on firmware version. Whether the HTTP-only path applies to older firmware, and which model families expose HTTPS on 443, was not established. **Uncertain.**

## Path 3: SSDP plus WebSocket port scan (Creality-Control, Home Assistant)

Source: [SiloCityLabs/Creality-Control](https://github.com/SiloCityLabs/Creality-Control/tree/8e3c9a4a398dad89c61079fc3d2728916bb4dc64).

- Discovery is SSDP. The integration manifest declares the search target `urn:creality:device:3dprinter:1` ([manifest.json](https://github.com/SiloCityLabs/Creality-Control/blob/8e3c9a4a398dad89c61079fc3d2728916bb4dc64/custom_components/creality_control/manifest.json)). Home Assistant's SSDP component delivers the matches. The host is taken from the advertised location URL ([config_flow.py L44-54](https://github.com/SiloCityLabs/Creality-Control/blob/8e3c9a4a398dad89c61079fc3d2728916bb4dc64/custom_components/creality_control/config_flow.py#L44-L54)).
- Port detection tries these TCP ports in order: 9999, 18188, 8080, 80 ([`__init__.py` L458-466](https://github.com/SiloCityLabs/Creality-Control/blob/8e3c9a4a398dad89c61079fc3d2728916bb4dc64/custom_components/creality_control/__init__.py#L458-L466)).
- Test on each port: open `ws://<host>:<port>/`, send a JSON message with command `GET_PRINT_STATUS` and an empty token, and wait up to 3 s for any reply. Any reply counts as a Creality printer ([`__init__.py` L469-](https://github.com/SiloCityLabs/Creality-Control/blob/8e3c9a4a398dad89c61079fc3d2728916bb4dc64/custom_components/creality_control/__init__.py#L469)). This check is weak: any WebSocket server that answers passes it.
- The README says the WebSocket protocol was found by Wireshark capture of Halot software on a Creality resin printer and a K1SE. It also says it may not apply to all printers ([README.md](https://github.com/SiloCityLabs/Creality-Control/blob/8e3c9a4a398dad89c61079fc3d2728916bb4dc64/README.md)). Treat the command as **uncertain** outside those models.

## Other Home Assistant integrations (checked, no discovery found)

- 3dg1luk43/ha_creality_ws: its CHANGELOG mentions printers being "discovered" and offered for confirmation, but no SSDP, zeroconf or UDP discovery code was found in the source tree at the pinned commit ([repository](https://github.com/3dg1luk43/ha_creality_ws/tree/58c00818e8303a0d636bd05929cad215aed9ccb3)). The discovery mechanism used by that integration is **unknown**.
- rathlinus/ha-creality-lan: the WebSocket client is in [ws.py](https://github.com/rathlinus/ha-creality-lan/blob/0ec15420079b97b2ef2f3e0be27a9fb741fc1e50/custom_components/creality_lan/ws.py). It takes a configured address. No discovery code was found.
- hurricaneb/hass_creality_k1: no discovery code was found; the README and manifest only.

## Ports and transports summary

- UDP 5353 multicast to 224.0.0.251: mDNS enumeration of `_services._dns-sd._udp.local.` (Creality Print).
- TCP 80 and 443: `/info` identity probe (Creality Print). HTTPS on 443 is preferred.
- TCP 9999, 18188, 8080, 80 with WebSocket: port guess (Creality-Control).
- SSDP search target `urn:creality:device:3dprinter:1` (Creality-Control).
- WebSocket control and camera ports come from the `/info` reply (`wssPort`, `videoPort`) on the HTTPS path.

## Open questions

- Whether any Creality printer answers the mDNS query with a name that does not contain `creality`, `Creality` or `CXSWBox`. Not checked.
- The meaning of the digits in legacy instance names.
- Whether the `/info` endpoint exists on every model and firmware. Not checked against hardware.
- The wire-level format of the mDNS answer for real printers. Not captured.
- Whether the SSDP advertisement is sent by the printer itself or by a Creality box. Not checked.

## Simulator and client notes

- To simulate discovery, a simulator must answer the mDNS query on UDP 5353 with a PTR answer whose instance name contains a Creality marker, with flags 0x8400 and transaction ID 0.
- It must serve `GET /info` on port 80 or 443 with JSON containing `model` and `mac`. For HTTPS it must also return `wssPort` and `videoPort`.
- These notes describe what the clients expect. They are not a replacement for capturing a real printer.
