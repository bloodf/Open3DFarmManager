# Kobra and ACE Pro report fixtures

**Reference-derived, not captured.** No printer produced these files. SKUs,
RFID values and message ids are placeholders; no serial or device id appears.

| File                  | Content                                               |
| --------------------- | ----------------------------------------------------- |
| `one-ace.json`        | One ACE unit: RFID present and absent, empty, unknown |
| `two-ace-holder.json` | Spool holder (box `-1`) and two ACE units             |
| `extfilbox.json`      | External spool reply                                  |

Field shapes follow:

- `bloodf/kobracontrol@ed298ff44f48a5ed2db0ac08e7e19243d542e14c`:
  `tests/kobra_captures.py` (`multiColorBox` slot keys), `tests/test_models.py`
  (`sku`), `src/kobracontrol/ace.py` (`rfid`, box ids).
- `bloodf/spooler@911dc7efa8d2a6c24b445170d9af34f28dbb9658`:
  `plugin/spooler/anycubic.py` (`extfilbox` data, empty slot, 100 percent).

Gaps: no reference captures a tag-read slot or an `extfilbox` reply, so the
`rfid` values and the external spool's extra keys are the least certain.
