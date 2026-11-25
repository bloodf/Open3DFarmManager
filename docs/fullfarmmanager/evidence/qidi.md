# Qidi driver evidence

All models remain **unqualified**. Every value in the simulator and tests is
synthetic: spec-derived, not captured. No printer was contacted. The operator
provisions the origin and the model; the Moonraker probe identifies neither.

## Pinned sources

Names and wire fields were read from these commits. No source code or firmware
file is copied into this repository.

| Key    | Repository, commit and paths                                                                                                                                                                                                                                                                   | Licence  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Q1     | [QIDITECH/QIDI_Q1_Pro@b4b4171](https://github.com/QIDITECH/QIDI_Q1_Pro/tree/b4b417116f6c44d1d1c0a4ef3f3f9a7cdb5dbdaf/config): `config/printer.cfg`, `config/gcode_macro.cfg`                                                                                                                   | AGPL-3.0 |
| P4     | [QIDITECH/QIDI_PLUS4@c4398be](https://github.com/QIDITECH/QIDI_PLUS4/tree/c4398bedad11e85ddfaf197e25a2c7154315d498/config): `config/{printer,gcode_macro,box,box1}.cfg`                                                                                                                        | AGPL-3.0 |
| Q2     | [QIDITECH/QIDI_Q2@3f6bcc8](https://github.com/QIDITECH/QIDI_Q2/tree/3f6bcc8bc295ecf067b45345c5bdb2139b287f17/config): `config/{printer,gcode_macro,box,box1,officiall_filas_list}.cfg`, `klipper/klippy/extras/save_variables.py`                                                              | GPL-3.0  |
| M4     | [QIDITECH/QIDI_MAX4@47fc14c](https://github.com/QIDITECH/QIDI_MAX4/tree/47fc14cefe064dbd30b90582429fe650883ae900/config): `config/{printer,box}.cfg`, `config/klipper-macros-qd/{fans,heaters}.cfg`                                                                                            | GPL-3.0  |
| XM3    | [QIDITECH/QIDI_MAX3@ec09329](https://github.com/QIDITECH/QIDI_MAX3/tree/ec0932953b394552a4327e8682accf119795bacb/src): screen client `src/mks_printer.cpp`, `src/event.cpp`, `src/KlippyGcodes.cpp`                                                                                            | GPL-3.0  |
| XP3    | [QIDITECH/QIDI_PLUS3@d090d42](https://github.com/QIDITECH/QIDI_PLUS3/tree/d090d42fb20c679726bd519d2e89a55a7faa1051/src): screen client `src/mks_printer.cpp`, `src/event.cpp`, `src/KlippyGcodes.cpp`                                                                                          | GPL-3.0  |
| XS3    | [QIDITECH/QIDI_SMART3@2adb476](https://github.com/QIDITECH/QIDI_SMART3/tree/2adb47605453561985d6cfd3089bd185a3f4e01d/src): screen client `src/mks_printer.cpp`, `src/event.cpp`, `src/KlippyGcodes.cpp`                                                                                        | GPL-3.0  |
| Studio | [QIDITECH/QIDIStudio@21d4745](https://github.com/QIDITECH/QIDIStudio/blob/21d47457919212b8af3f97705716c261b97be559/src/slic3r/GUI/QDSDeviceManager.cpp): `src/slic3r/GUI/QDSDeviceManager.cpp`, status parsing and `updateBoxDataByJson`                                                       | AGPL-3.0 |
| Klip   | [QIDITECH/klipper@653d7a8](https://github.com/QIDITECH/klipper/tree/653d7a8f6ec4700ec02c2319888ad98a92c1a0c3/klippy/extras): `get_status` in `fan.py`, `fan_generic.py`, `heaters.py`, `output_pin.py` (fan `speed` and pin `value` are 0..1; heaters report `temperature` and `target` in °C) | GPL-3.0  |

The Moonraker object query is documented in the
[Moonraker external API](https://moonraker.readthedocs.io/en/latest/external_api/printer/#query-printer-object-status).
These are published repository states. None proves what an installed printer's
firmware or edited configuration exposes.

## Model profiles

`expect.model` in the local binding selects
[`profiles.ts`](../../../packages/connector/src/qidi/profiles.ts). The
Connector queries only that model's objects, with `webhooks`, `print_stats`,
`virtual_sdcard`, `extruder` and `heater_bed`. A binding without a model keeps
the previous query (`fan`, then `fan_generic cooling_fan`) and publishes status
and progress only.

| Model     | Part fan                  | Auxiliary fan                                          | Chamber circulation fan               | Chamber temperature and target | Box slots                | Source     |
| --------- | ------------------------- | ------------------------------------------------------ | ------------------------------------- | ------------------------------ | ------------------------ | ---------- |
| Q1 Pro    | `fan_generic cooling_fan` | `fan_generic auxiliary_cooling_fan`                    | `fan_generic chamber_circulation_fan` | `heater_generic chamber`       | unknown                  | Q1, Klip   |
| Plus4     | `fan_generic cooling_fan` | `fan_generic auxiliary_cooling_fan`                    | `fan_generic chamber_circulation_fan` | `heater_generic chamber`       | unknown                  | P4, Klip   |
| Q2        | `fan_generic cooling_fan` | `fan_generic auxiliary_cooling_fan`                    | `fan_generic chamber_circulation_fan` | `heater_generic chamber`       | unknown                  | Q2, Klip   |
| Max4      | `fan_generic cooling_fan` | `auxiliary_cooling_fan` and `auxiliary_cooling_fan2` ¹ | `fan_generic chamber_circulation_fan` | `heater_generic chamber`       | `multi_color_controller` | M4, Studio |
| X-Max 3   | `fan`                     | unknown                                                | unknown                               | unknown                        | unknown                  | XM3, Klip  |
| X-Plus 3  | `output_pin fan0`         | `output_pin fan2`                                      | `output_pin fan3`                     | `heater_generic hot`           | unknown                  | XP3, Klip  |
| X-Smart 3 | `fan`                     | unknown                                                | unknown                               | unknown                        | unknown                  | XS3, Klip  |

¹ M106 P2 sets both `fan_generic` objects. The farm has one auxiliary reading,
so it appears only when both report the same percentage.

- Q-series: each configuration declares the sections, and its `M106 P0`, `P2`
  and `P3` and `M141` macros name their roles. The `chamber_fan` section
  (`[chamber_fan]` or `[controller_fan]`, tied to the heater) and
  `Chamber_Thermal_Protection_Sensor` are not reported. QIDIStudio reads the
  same chamber and fan names.
- X-Plus 3: comments in `mks_printer.cpp` map `fan_generic cooling_fan`,
  `auxiliary_cooling_fan` and `chamber_circulation_fan` to `output_pin fan0`,
  `fan2` and `fan3`, and `heater_generic chamber` to `heater_generic hot`;
  `event.cpp` calls the latter the chamber heating variable. The comments are
  phrased as notes of changes to make. The live subscription uses the new
  names, and its fan setters send `M106 P0`, `P2` and `P3`. This is the weakest
  mapping reported.
  The client also subscribes `fan`; the profile does not fall back to it.
- Max4 Box: the object is declared in `config/printer.cfg`. QIDIStudio reads
  `box_count`, `box{n}_box_inserted_{s}`,
  `box{n}_filament_info_{s}_filament_type` and `..._color_rgb_str` (an array;
  the first string), from the object or its `box` member. Up to four Boxes of
  four slots. Only occupied slots of reported Boxes appear. A colour is kept
  only in the `#RRGGBB` form of Qidi's `officiall_filas_list.cfg` `colordict`;
  that the object uses this form is an inference, so any other form stays
  unknown.
- A missing optional object, or a missing, mistyped or out-of-range value
  inside one, stays unknown and keeps print state and progress. As before, a
  queried object that is not a JSON object rejects the whole response. Printer identity stays `Qidi`: the
  model is provisioned, not observed.

## Refused or unreported

| Field or operation                                    | Reason                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plus4 and Q2 Box slots                                | Their configurations declare Box hardware (`box_stepper slot0`..`slot3`, `heater_generic heater_box1`) in `box1.cfg`, commented out in `box.cfg`, and no `multi_color_controller`. Q2's `save_variables.py` exposes `box_count`, `slot{i}`, `color_slot{i}` and `filament_slot{i}`, but no pinned source defines the `slot{i}` states, and Q2 ships its Box modules as binaries. |
| Q1 Pro and X-series Box slots                         | The pinned sources contain no Box configuration or status schema for these models.                                                                                                                                                                                                                                                                                               |
| X-Max 3 and X-Smart 3 auxiliary and circulation fans  | The screen clients subscribe `output_pin fan0`, `fan2` and `fan3` without naming what each drives. Their part fan reads only `fan`, which both clients subscribe and Klipper defines as the print cooling fan; whether the installed printer has it is unverified.                                                                                                               |
| X-Max 3 and X-Smart 3 chamber                         | Both clients subscribe `heater_generic hot` without stating that it is the chamber.                                                                                                                                                                                                                                                                                              |
| Max4 external spool                                   | `extra.filament_info` has no presence field; QIDIStudio always treats it as present.                                                                                                                                                                                                                                                                                             |
| Box temperature, humidity, drying state, vendor, name | QIDIStudio reads them from `multi_color_controller`. The farm printer state has no field for them.                                                                                                                                                                                                                                                                               |
| Active Box slot and remaining filament                | `last_load_slot` records the last load, not the active slot. No remaining amount is sourced.                                                                                                                                                                                                                                                                                     |
| Fan, chamber, heater and Box writes                   | The maker macros and clients show `M106`, `M141`, `SET_FAN_SPEED`, `SET_PIN` and `SET_HEATER_TEMPERATURE` forms. Qidi has no Connector command driver, so no signed-command check, interlock or owner qualification could gate them. None is added.                                                                                                                              |
| Start, pause, resume, cancel                          | Same: no Qidi command driver. The runtime advertises no controls for Qidi.                                                                                                                                                                                                                                                                                                       |

## Operations exercised

- Adapter transports over loopback: server probe, object query, newest history
  page, configured same-origin JPEG snapshot, and API-key G-code upload without
  print start (`tests/node/qidi-protocol.test.ts`,
  `tests/node/qidi-flashforge-models.test.ts`). These call the adapter without
  a model. Upload is not wired into the Connector runtime.
- Connector collection into the live read-only frame, per model, with decoy
  objects: `tests/unit/qidi-variants.test.ts` and
  `tests/unit/qidi-collection.test.ts`.
- Browser journey, `tests/journey/qidi.spec.ts`: the shared Q1 Pro status,
  connection loss and recovery journey, plus one test per model asserting the
  exact query, the fan labels and percentages, the Max4 Box slots, the absence
  of Box rows elsewhere and the absence of controls.
- No farm page renders chamber temperature or target. They reach the live
  frame (unit test); the browser journey cannot assert them.

## Before qualification

Capture the installed firmware identity, LAN authentication, endpoint, object
list and values on each model, including optional Box units and an operator
edited configuration. Confirm the X-series roles and the Max4 Box payload
against a stock printer. Verify cameras and any command path separately.
