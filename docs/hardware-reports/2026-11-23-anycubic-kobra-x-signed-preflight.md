# Anycubic Kobra X signed control preflight

Hardware acceptance stopped during onboarding on November 23, 2026. The
Connector and farm app were built on macOS from
`cc092a6db5281f7961e04cebf9c19df453eee21e` after PR #808 merged. The Connector
paired with an isolated local farm, and the browser key was approved.

| Check                              | Observation                                                                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct LAN reachability            | Both direct ports initially returned `EHOSTUNREACH`. A later attempt reached `GET /info` over port 18910 and confirmed Kobra X model `20030` in LAN mode. A TCP connection to port 9883 also succeeded.                 |
| Native signed onboarding           | OpenFarm reported that it could not establish or complete the secure `config-v1` session with the Connector. The failure occurred before the browser dispatched configuration, with both loopback and LAN ICE bindings. |
| Native assignment and broker trust | Blocked by onboarding. The Connector wrote no native binding or stored broker pin.                                                                                                                                      |
| Physical print and signed controls | No file upload, print start, pause, resume, or heater command was sent. There are no print results or pause timings.                                                                                                    |

The run adds no hardware-proven control capabilities. [Issue #259](https://github.com/bloodf/Open3DFarmManager/issues/259)
tracks hardware qualification.
