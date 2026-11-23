# Project plan

## Current status

Development resumed on 2026-11-11 ([PR #104](https://github.com/bloodf/Open3DFarmManager/pull/104)). Phase 0 is incomplete, and its remaining work is tracked by the roadmap epics below. All fifteen epics are open.

| Epic | Scope                                                             | Issue                                                          |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| E1   | Connector: signed control stays safe on every assigned printer    | [#168](https://github.com/bloodf/Open3DFarmManager/issues/168) |
| E2   | Connector: trusted keys, storage failures and outage safety       | [#177](https://github.com/bloodf/Open3DFarmManager/issues/177) |
| E3   | Simulators: both printers, Spoolman, cameras and network faults   | [#184](https://github.com/bloodf/Open3DFarmManager/issues/184) |
| E4   | Server: prove migrations, database suites and diagnostics         | [#190](https://github.com/bloodf/Open3DFarmManager/issues/190) |
| E5   | Acceptance: one candidate passes the full Phase 0 flow            | [#194](https://github.com/bloodf/Open3DFarmManager/issues/194) |
| E6   | Server: latest printer state and bounded telemetry retention      | [#200](https://github.com/bloodf/Open3DFarmManager/issues/200) |
| E7   | API: versioned integration API to observe and control the farm    | [#204](https://github.com/bloodf/Open3DFarmManager/issues/204) |
| E8   | Accounts: owners manage members, passwords and sessions           | [#216](https://github.com/bloodf/Open3DFarmManager/issues/216) |
| E9   | Web: complete, navigable farm interface usable without P2P        | [#224](https://github.com/bloodf/Open3DFarmManager/issues/224) |
| E10  | Adapters: every family passes its journey with an honest catalog  | [#231](https://github.com/bloodf/Open3DFarmManager/issues/231) |
| E11  | Install: self-host the app and run the Connector as a service     | [#243](https://github.com/bloodf/Open3DFarmManager/issues/243) |
| E12  | Release: versioned builds and a documented upgrade path           | [#251](https://github.com/bloodf/Open3DFarmManager/issues/251) |
| E13  | Hardware: owner-run acceptance on real printers                   | [#255](https://github.com/bloodf/Open3DFarmManager/issues/255) |
| E14  | Spoolman: OpenFarm connects each farm to its Spoolman             | [#276](https://github.com/bloodf/Open3DFarmManager/issues/276) |
| E15  | Bambu cloud: import printers, print history and AMS from accounts | [#282](https://github.com/bloodf/Open3DFarmManager/issues/282) |

The [Phase 0 ledger](PHASE-0.md) records what each checkpoint proves and which gates remain open. The [implementation queue](IMPLEMENTATION-QUEUE.md) lists the remaining work in dependency order and the PRs that delivered the rest. Historical checkpoints remain as history and do not describe the current tree.

## Tooling preparation

Follow [AI tooling](ai-tooling.md) for CodeGraph, RTK, skills and model routing. Review the exact tooling candidate and pass required checks before merging a tooling PR. The central coordinator owns propagation and records its coverage and blockers. Product work follows the epics above and the existing project safety and validation rules.
