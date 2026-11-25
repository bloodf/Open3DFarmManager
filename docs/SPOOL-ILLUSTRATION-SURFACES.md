# Spool illustration surfaces

`SpoolIllustration.vue` renders a reel for a spool or a slot that reports a
spool. The level uses Spoolman remaining weight divided by the initial
filament weight, with the filament's nominal weight as the fallback
denominator. A slot can fall back to the printer's reported percentage. Zero
renders an empty reel. If the level is unavailable, the full reel shows a
question mark and the accessible name **Nível restante desconhecido**.

| Surface                                                                     | Spool and level source                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Bobinas** list and edit, use, and weigh dialogs                           | The selected record from the farm's spool library.                                                            |
| **Localizar**, **Etiquetas QR**, **Secagem e umidade**, and **Uso e custo** | The library spool shown in the result, picker, or usage record. Usage records show the current library level. |
| **Slots** list and assignment picker                                        | The library spool linked by the assignment or selected in the form. This page has no printer readings.        |
| Live **Estoque de filamento** in the farm                                   | The Connector's Spoolman mirror. Older snapshots can have a weight without a percentage.                      |
| FullFarmManager inspector, material list, active spool form, and wall table | The current Spoolman spool linked to the slot by the browser's saved assignment, then the printer slot.       |
| Printer details, including AMS, ACE, and CFS                                | The same browser assignment and slot readings. Moonraker can report its active Spoolman spool directly.       |
| Replay filament matching and Kobra X file input selection                   | The slot selected for each file filament. Changing the selection changes the illustration.                    |
| AMS load filament selection                                                 | The selected tray's assigned Spoolman spool, then its printer percentage.                                     |

Live assignment lookups use the current Connector's mirror for the row's
agent. The mirror is bounded and excludes some spool records from large
inventories. An old, missing, or unlinked spool uses the printer percentage
when the slot provides one. The UI never links spools by color or material.

Filament catalog entries, stock thresholds, and aggregate reports describe
filament types or totals. They have no individual reel level. Native select
options and printed QR labels keep their original text, while selected spool
or slot previews carry the illustration in the form.

Theme coverage uses the loopback fixtures in
`tests/unit/spool-illustration.test.ts`, `tests/e2e/spool-library.spec.ts`, and
`tests/e2e/spool-features.spec.ts`.
