# Snapmaker U1 Moonraker live status

The reference profile is the Snapmaker U1 with Moonraker 2.0.0 and Klipper
`2.0.0-paxx12-24`. Its idle WebSocket can deliver process statistics without
delivering a printer status delta. A peer that stops receiving complete
printer observations loses its live snapshot and reports `source-unavailable`.

## Protocol references

| Repository and revision                                                                                         | Path                                                                                                                                                                                                                                                                                                                                                                          | Behavior used by the Connector                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OrcaSlicer/OrcaSlicer `f92a7c065c5718b8ef1baac1cd704df2911238f4` (v2.5.2)                                       | [`src/slic3r/Utils/MoonrakerPrinterAgent.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/f92a7c065c5718b8ef1baac1cd704df2911238f4/src/slic3r/Utils/MoonrakerPrinterAgent.cpp#L1405) and [`src/slic3r/Utils/SnapmakerPrinterAgent.hpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/f92a7c065c5718b8ef1baac1cd704df2911238f4/src/slic3r/Utils/SnapmakerPrinterAgent.hpp) | Discover and read objects via HTTP. Use an identified WebSocket for subscriptions and merge incoming status deltas into the initial status. The Snapmaker agent inherits this status exchange.   |
| Arksine/moonraker `b559b9a81161f958a43c2f527b6ad96f73310d5d`                                                    | [`docs/external_api/printer.md`](https://github.com/Arksine/moonraker/blob/b559b9a81161f958a43c2f527b6ad96f73310d5d/docs/external_api/printer.md#L221-L375) and [`docs/external_api/jsonrpc_notifications.md`](https://github.com/Arksine/moonraker/blob/b559b9a81161f958a43c2f527b6ad96f73310d5d/docs/external_api/jsonrpc_notifications.md)                                 | A complete query returns `result.status` and `result.eventtime`. A subscription selects the object fields to watch and emits `notify_status_update` with a partial status and source event time. |
| Snapmaker/u1-moonraker `a308cfae31b7eb70ebf96bc73e6968d9792e4d73`                                               | [`moonraker/components/klippy_connection.py`](https://github.com/Snapmaker/u1-moonraker/blob/a308cfae31b7eb70ebf96bc73e6968d9792e4d73/moonraker/components/klippy_connection.py#L674-L767)                                                                                                                                                                                    | A covered subscription can return cached status with the last delta timestamp. A complete query reaches Klipper for a new observation.                                                           |
| Snapmaker/u1-klipper `93cb12faebf6e74c51bbc5f0be66e95124af14c8`                                                 | [`klippy/webhooks.py`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/klippy/webhooks.py#L485-L563)                                                                                                                                                                                                                                    | Klipper collects queries and subscription deltas in the same reactor turn. Both can use the same source event time.                                                                              |
| Snapmaker/u1-klipper `93cb12faebf6e74c51bbc5f0be66e95124af14c8`                                                 | [`klippy/extras/print_stats.py`](https://github.com/Snapmaker/u1-klipper/blob/93cb12faebf6e74c51bbc5f0be66e95124af14c8/klippy/extras/print_stats.py)                                                                                                                                                                                                                          | Cancellation sets the current `print_stats.state` to `cancelled`; the status response reports that state.                                                                                        |
| paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware `417e6394f62366e010a3f76f8e567f67db770165` (v2.0.0-paxx12-24) | [`overlays/firmware-extended/12-patch-moonraker`](https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware/tree/417e6394f62366e010a3f76f8e567f67db770165/overlays/firmware-extended/12-patch-moonraker)                                                                                                                                                           | This release overlays Snapmaker firmware. Its Moonraker patch changes file metadata extraction.                                                                                                  |

## OpenFarm status exchange

The Connector uses read-only HTTP object discovery and complete status queries,
with an identified WebSocket for the initial subscription and deltas. It asks
for an explicit subset of fields using Moonraker's field-array form. The U1
profile projects `webhooks.state`, `print_stats` state and job fields,
`virtual_sdcard.progress`, `toolhead.extruder`, nozzle and bed temperatures and
targets, and discovered fan readings. The nozzle object names
are `extruder`, `extruder1`, `extruder2` and `extruder3` for T0–T3. The active
nozzle display follows `toolhead.extruder`.

OrcaSlicer queries status once when it starts the stream. OpenFarm also
queries during idle periods to refresh the complete evidence. Freshness starts
at the local request time. `notify_proc_stat_update` carries process data and
does not refresh printer evidence. A WebSocket disconnect or Klipper shutdown
invalidates the live source. The five-second evidence lifetime and signed
command checks remain in force.

For compatibility with existing strict readers, a ready Moonraker cancellation
retains the `unknown` wire state with a reserved diagnostic in `statusMessage`.
Updated browsers use that current observation for collection and replay checks;
old readers remain read-only. A last-job summary alone is not current evidence,
and the Connector remains responsible for enforcing each command's safety rules.

The read-only U1 capture confirmed the HTTP `result` envelope, the four
nozzle temperatures and targets, the bed temperature and target,
`toolhead.extruder` and `print_stats.info`. WebSocket replies had numeric
`cli_time` and `dev_time` metadata. The [loopback parity fixture](../../tests/node/moonraker-client-active-tool.test.ts)
replays the status exchange and asserts the Connector observations and the
fields sent to the authenticated live view. The catalog grade
`reference-matched` covers this read-only status exchange. Hardware control
qualification remains pending.

The fixture reproduces `source-unavailable` when the previous Connector
receives a valid subscription and the periodic WebSocket query receives no
reply. The read-only payload capture establishes wire shape. The cause of
the earlier hardware preflight disconnect remains unconfirmed.
