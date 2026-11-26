# Anycubic FDM: Kobra 4, Kobra 3 Max V2 and Kobra S1 Max

Checked 2026-11-26. Every model stays **unqualified**. No physical printer was contacted. All simulator state is synthetic. Nothing here was captured by this project; the references are community reverse engineering, not Anycubic protocol documents. Only facts were taken from them, no code.

## Sources

| Id  | Source                                                                                                                                                                                                                                                                                                                                                       | What it establishes                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | [bloodf/kobracontrol@1cd140a](https://github.com/bloodf/kobracontrol/blob/1cd140a2d37925d7be1f907647f0a86b316a7199/docs/models.md) (owner reference, GPL-3.0): `docs/models.md`, `docs/protocol.md`, `tests/test_models.py`, `src/kobracontrol/{profiles,kobra}.py`                                                                                          | Model codes 20028 and 20029, temperature maxima, LAN mode, one-client note, command names. Every model except the Kobra X is "experimental, never tried".                                                                                                |
| H1  | [chrisfore/anycubic_ha_local@8ef65af](https://github.com/chrisfore/anycubic_ha_local/blob/8ef65afd2493c148bf70ee40c6168a2b8efe9b41/research/PROTOCOL-VALIDATED.md) (MIT/AGPL): `research/PROTOCOL-VALIDATED.md`, `custom_components/anycubic/const.py`, `anycubic_local/{const,commands,models}.py`, `tests/fixtures/`, `tests/test_light_entity.py`, README | S1 Max validated on hardware by its author (firmware 2.6.9.6): report shapes, `web` topic queries and commands, chamber fields, chamber light type 2, `remain_time` in minutes. Kobra 4 "validated by a user"; camera light type 3 and no chamber light. |
| R1  | [jbatonnet/Rinkhals@04c6900](https://github.com/jbatonnet/Rinkhals/blob/04c690017459a8b4cdceee2eb03125b705bdda1e/files/3-rinkhals/tools.sh) (MIT)                                                                                                                                                                                                            | On-printer `modelId` 20029 is the Kobra S1 Max. Lists neither a Kobra 4 nor a Max V2.                                                                                                                                                                    |
| C1  | [rvanderp3/kobra-connect@3edba24](https://github.com/rvanderp3/kobra-connect/blob/3edba24606d7122c4a68accd09af937ba4fdbd08/docs/mqtt-commands.md) (Apache-2.0)                                                                                                                                                                                               | Requests go to `slicer/` or `web/` topics; reports come on `printer/public/`; 20029 is the KS1 Max.                                                                                                                                                      |
| O1  | [SoftFever/OrcaSlicer@055edc0](https://github.com/SoftFever/OrcaSlicer/blob/055edc0982a91c13afb39b1386a12ce412b1db42/resources/profiles/Anycubic/machine/Anycubic%20Kobra%203%20Max%20V2.json)                                                                                                                                                               | A slicer profile named "Anycubic Kobra 3 Max V2" exists. Its `model_id` is that name, not a LAN code.                                                                                                                                                    |

## Model ids

| Model          | LAN `modelId` | Firmware seen in sources                 | Sources                        |
| -------------- | ------------- | ---------------------------------------- | ------------------------------ |
| Kobra 4        | `20028`       | none                                     | K1, H1                         |
| Kobra S1 Max   | `20029`       | `2.6.9.6` (H1, hardware), `2.7.1.4` (K1) | K1, H1, R1, C1                 |
| Kobra 3 Max V2 | **unknown**   | none                                     | O1 gives only the product name |

**Kobra 3 Max V2 stays unsupported.** No source gives its LAN `modelId` or identity strings. `20026` is the Kobra 3 Max, a different product, and is not assumed to cover the V2. Searched on 2026-11-26: the four owner references (K1, `spooler`, `u1control`, `orca-ui-foundation`), H1, R1, C1, `ianloic/anycubic-orca-plugin`, `sebmueller/kobra3-lan-bridge`, `norjms/openprinthq-engine`, `grunna/ha-anycubic-kobra-x-lan`, `briancoy/Orca_Anycubic_Kobra_3_MAX`, `James-Jennison/nozzle-it-all`, and web search. A Max V2 that reports an id this table does not list gets what any unlisted id already gets: the generic experimental subscriber, no controls, no files, no detail feed.

## Wire facts used

Topics: reports on `anycubic/anycubicCloud/v1/printer/public/{modelId}/{deviceId}/{type}/report` (H1, C1); requests on `anycubic/anycubicCloud/v1/web/printer/{modelId}/{deviceId}/{type}` (H1, C1).

| Fact                  | Kobra 4 (20028)                                                                     | Kobra S1 Max (20029)                       | Source |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| `info/report`         | `state` `free`/`busy`; `project` null when idle; `temp{curr_*,target_*}`; `version` | same                                       | H1, K1 |
| Job phase             | `project.state`, `project.pause`; a resumed job reads `resumed`                     | same                                       | H1     |
| `remain_time`         | minutes (family claim)                                                              | minutes (hardware)                         | H1     |
| Chamber               | none                                                                                | `curr_chamber_temp`, `target_chamber_temp` | H1     |
| Lights                | camera light type 3 only; the report may list type 2 too                            | chamber light type 2                       | H1     |
| Bed maximum           | 100 °C                                                                              | 120 °C                                     | K1     |
| Pause, resume, stop   | `print/{action}` with `{taskid:"-1"}`                                               | same                                       | H1, K1 |
| Temperature, part fan | `print/update` `{taskid, settings}`                                                 | same                                       | H1     |
| Light                 | not sent                                                                            | `light/control {type:2,status,brightness}` | H1     |
| Read request          | `info/query`, `light/query`, `data:null`                                            | same                                       | H1     |

For the Kobra 4, H1 states only that a user validated the integration; the shared wire shapes are inferred from "same LAN protocol" (H1, K1), not observed per field.

## What the Connector does

Code: `packages/connector/src/anycubic/{models,report,control-support,lan-control-driver}.ts`, and the Anycubic chamber stamps in `runtime/farm-snapshot-provider.ts`.

Read-only, with no configuration beyond the existing Anycubic binding:

- State, progress, nozzle and bed temperature, remaining time and the detail feed.
- Idle (`free`, no project) reports progress 0, so it is published; without it these models would show as offline whenever idle.
- A resumed job reads as printing.
- S1 Max only: chamber temperature (in the status snapshot and the integration API; no web page shows it), chamber light state and chamber fan. Kobra 4: a type 2 light entry and `box_fan_level` (enclosure only, H1) are ignored.
- Nothing is published to the printer.

Writes are behind `ANYCUBIC_QUALIFIED_WRITES` (`anycubic/models.ts`), exact `(modelId, firmwareVersion)` pairs, which **ships empty**. The CLI cannot change it. For a qualified pair with local `pause.control` opt-in:

- The router reads the firmware with `info/query` at start-up; the driver checks it again on every attempt. Another firmware offers and sends nothing.
- Pause, resume, cancel, extruder and bed temperature, part fan; chamber light on the S1 Max only. Temperature and fan are refused while idle, and a Kobra 4 bed target above 100 °C is refused.
- Each command is sent once. It is confirmed only by a later report showing the result; otherwise it ends uncertain and is not resent. Only reads are repeated.

Refused for these models, even when qualified:

| Operation            | Reason                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start print          | The `print/start` in K1 and H1 carries `filepath`, `ams_settings`, `task_settings`, `filesize` and `md5`, which the Connector's Kobra 3 start does not build. H1 marks its own shape unverified. |
| File list and upload | Not wired. In this product file authority rides on an advertised `start_print`, and a file session is a further MQTT connection (see gap 2).                                                     |
| Camera               | Not claimed. K1 and H1 report an FLV stream on `:18088`; nothing was built or tested for these models.                                                                                           |

## Simulator and tests

`packages/sim-tools/src/anycubic-simulator.ts` with `modelId` `20028` or `20029`. Firmware `2.6.9.6` for the S1 Max comes from H1; `sim-kobra-4` is a made-up marker because no Kobra 4 version was found. It pushes `info`, `tempature` and `light` reports periodically, which is a simulator liberty (gap 1). Temperatures, progress and the 30 minute default are synthetic.

| Test                                    | Covers                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/node/anycubic-models.test.ts`    | Empty shipped list; per-model decoding; status, loss and recovery per model; no publish when unqualified; wrong firmware; each qualified command per model; refusals; no resend.                                                          |
| `tests/journey/anycubic-models.spec.ts` | Browser, per model: status, loss and recovery with the shipped Connector and no control; then, with the test-only pairs of `tests/helpers/anycubic-qualified-connector.ts`, temperature, pause, resume, cancel (and light on the S1 Max). |

## Gaps before qualification

1. **Report cadence.** The collector only subscribes and drops a state 5 seconds old. H1 saw `info/report`, the only source of the job phase, about every 30 s with the Slicer attached and minutes apart without it. On hardware, status would likely be missing most of the time. Fixing this means publishing `info/query` from the read-only collector, a change to its no-publish rule that was not made here. This applies to the Kobra 3 path too.
2. **One LAN client.** K1 says the Kobra 3, S1 and (in its table) Kobra 4 accept one LAN client at a time. H1 describes the Slicer and a second client both receiving reports, and also a client being dropped when the Slicer connected. The Connector's control driver opens a connection beside the collector's. If the printer refuses it, controls are not offered or fail before sending; they would need the collector's session.
3. **Preparation phases** (`preheating`, `auto_leveling`, `vibrating`, `flow_calibrating`, `pausing`, `resuming`) give no state, so a long preparation ages out and shows as offline. Same on the Kobra 3 path.
4. **Idle without a job** is reported as progress 0 only for these two models; a Kobra 3 with `project: null` and no finished job is still not published.
5. **Client certificate.** K1 and C1 say the broker requires one. Set `clientCertFile`; the simulator does not require it.
6. **Job outcome.** A job seen to end only as `free` is recorded as cancelled; it reads as completed only if a `print/report` with `finished` arrives. The simulator sends no `print/report` for these models. Same rule as the Kobra 3 path.
7. **Hardware run.** Record the model, firmware and each command before adding a pair.

## Kobra 3 (20024) findings, not changed here

Found while comparing; the existing path was left as it was. Each needs its own decision.

- Pause, resume, cancel, temperature, fan and light publish to `…/printer/public/{modelId}/{deviceId}/{type}/request` (`anycubic/control-transport.ts`). None of K1, H1 or C1 uses that topic; the 20024 simulator accepts it, so its journeys cannot show a problem.
- The control driver expects `data.state` of `printing`/`paused`/`idle`, while H1 and K1 report `free`/`busy` with `project`.
- The control driver does not pass the configured client certificate; the collector and file session do.
