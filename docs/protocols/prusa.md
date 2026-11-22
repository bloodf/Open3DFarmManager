# Prusa protocol support

Evidence reviewed on 2026-11-22. Simulator replies are synthetic examples of documented contracts. Every model and firmware remains unqualified pending owner hardware checks.

## PrusaLink

An authenticated probe of a configured origin reads API version and printer info. The adapter uses API-key authentication and v1 endpoints. It reads reported printer and job state, current and target nozzle and bed temperatures, fan readings, and optional vendor telemetry. Missing values remain missing. The camera operation reads one snapshot where the endpoint is implemented. An empty snapshot response yields no image.

Uploads use raw PUT for the configured storage and filename. They omit `Print-After-Upload` because older implementations can interpret header presence as true. Upload requests request no overwrite. Start uses a separate POST. Pause and resume use the current numeric job ID and PUT. Cancel uses DELETE against that job. Every mutation requires the caller's synchronous send guard and uses one request. An HTTP success acknowledges the request. Completion requires a separate observed state. A lost response leaves the outcome uncertain.

Sources are the [PrusaLink v1 specification](https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml), [legacy specification](https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi-legacy.yaml), [Buddy firmware handlers](https://github.com/prusa3d/Prusa-Firmware-Buddy/tree/master/lib/WUI/link_content), and [PrusaSlicer upload and authentication implementation](https://github.com/prusa3d/PrusaSlicer/blob/master/src/slic3r-shared/src/Slic3r/Biz/PrintHost/PrintHostPrusaLink.cpp). The implementation and fixtures are original. The upstream AGPL specification and sources are referenced for interoperability.

| Models                                  | Vendor transport and qualification gap                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORE One, CORE One+, CORE One L         | Built-in Buddy PrusaLink. Verify v1 auth, storage and commands on each installed firmware. Camera depends on setup and endpoint availability.                                                            |
| XL                                      | Built-in Buddy PrusaLink. Verify storage and lifecycle per firmware, plus tool-specific telemetry for multi-tool configurations.                                                                         |
| MK4, MK4S, MK3.9, MK3.9S, MK3.5, MK3.5S | Built-in Buddy PrusaLink. Verify the v1 and raw PUT contracts on each installed firmware.                                                                                                                |
| MINI, MINI+                             | Built-in PrusaLink on current firmware. Earlier Connect Local firmware uses a different interface. Verify API-key v1 and PUT before enabling writes.                                                     |
| MK2.5, MK2.5S, MK3, MK3S, MK3S+         | Raspberry Pi PrusaLink. Prusa recommends Link 0.8.1 or newer for the legacy firmware improvements. Verify host version, reported storage, camera and serial firmware together.                           |
| SL1, SL1S SPEED                         | Built-in resin PrusaLink. SL1 firmware release history records the legacy-to-v1 transition. Verify authentication and supported resin file formats and controls separately. FDM telemetry may be absent. |

Model sources are [Prusa's availability table](https://help.prusa3d.com/article/prusa-connect-and-prusalink-explained_302608), [legacy printer firmware releases](https://github.com/prusa3d/Prusa-Firmware/releases), [Buddy releases](https://github.com/prusa3d/Prusa-Firmware-Buddy/releases), and [SL1 releases](https://github.com/prusa3d/Prusa-Firmware-SL1/releases). The simulated firmware label is an example. Per-model minimum versions for this complete operation set remain unverified.

Digest-only and legacy API configurations, automatic LAN discovery, live camera streaming, material and consumption tracking, alert history, temperature writes and fan writes are outside the implemented Link contract. Optional vendor status fields remain available as received.

## Prusa Connect Local

The self-hosted beta REST path uses a pre-issued bearer token. It lists visible devices, reads details by device ID, retrieves named camera snapshots and reads cursor-paged device job history. Device details preserve reported connection state, capabilities, readings, material fields and issues when supplied. The adapter does not infer consumption from material or progress.

The [official Connect Local reference](https://github.com/prusa3d/prusa-connect/tree/main/docs/src/content/docs/reference/api) defines these routes. Each installed server and model still needs qualification. Connect Local uploads and commands, hosted Prusa Connect account onboarding and cloud commands, and cloud camera ingestion remain open. The [printer SDK](https://github.com/prusa3d/Prusa-Connect-SDK-Printer) documents device enrollment rather than the operator authorization contract.

## Integration follow-up

- Add an explicit Prusa binding and credential provisioning in `packages/connector/src/control/printer-binding.ts` and `packages/connector/src/runtime/configuration.ts`. Pin the owner-approved origin and identity and use a restricted Connect Local token.
- Wire commands through `packages/connector/src/control/control-driver.ts` and the existing signed dispatcher. Require fresh identity, state and job checks, verified PUT capability for uploads, and the start interlock. Correlate post-send observations and preserve uncertainty.
- Register model and firmware evidence in `packages/connector/src/runtime/machine-profile.ts`, `docs/compatibility/adapter-admission.json`, and the FullFarmManager catalogs. Qualify each operation independently.
- Add pt-BR setup fields under `apps/farm/app/components/printer-setup/` and expose qualifications through `apps/farm/app/components/overview/CompatibilityProduct.vue`. Route live data and camera through the existing WebRTC boundary and keep degraded views read-only.
