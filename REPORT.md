# Owner-only actions

Agents and CI can merge, release candidate builds, and ship driver code on simulator evidence. Nothing here blocks those gates. Items below need the owner before they are **done**; until then, affected drivers stay **unqualified** on hardware.

Reference: [HARDWARE-ACCEPTANCE-CHECKLIST.md](docs/HARDWARE-ACCEPTANCE-CHECKLIST.md) (Klipper/Moonraker Phase 0 runbook, last open item of [#9](https://github.com/bloodf/Open3DFarmManager/issues/9)) and [fullfarmmanager/REVIEW.md](docs/fullfarmmanager/REVIEW.md) (driver evidence matrix).

## Policy (2026-11-23)

Hardware acceptance runs are **not** merge, release, or deploy gates. Cortex FDM drivers ship on simulator journeys; catalog rows stay unqualified until an owner run promotes them. Klipper Phase 0 hardware acceptance is likewise follow-up evidence, not a merge blocker.

## Hardware acceptance epic [#255](https://github.com/bloodf/Open3DFarmManager/issues/255)

- [#256](https://github.com/bloodf/Open3DFarmManager/issues/256) (**E13.1**, Klipper checklist): Run [HARDWARE-ACCEPTANCE-CHECKLIST.md](docs/HARDWARE-ACCEPTANCE-CHECKLIST.md) on real Klipper/Moonraker printers after simulator gates pass; post redacted results to [#9](https://github.com/bloodf/Open3DFarmManager/issues/9). Closes the last open item of Phase 0 acceptance [#9](https://github.com/bloodf/Open3DFarmManager/issues/9).
- [#257](https://github.com/bloodf/Open3DFarmManager/issues/257) (**E13.2**, Bambu): Owner-run qualification on LAN printers and catalog promotion per [docs/hardware-reports/README.md](docs/hardware-reports/README.md); Bambu had no printer on the LAN for the 2026-11-21 read-only runs.
- [#258](https://github.com/bloodf/Open3DFarmManager/issues/258) (**E13.3**, Creality): Same as Bambu for Creality stock-firmware printers; none on LAN yet.
- [#259](https://github.com/bloodf/Open3DFarmManager/issues/259) (**E13.4**, Anycubic / KobraLink): Full command and journey qualification beyond the existing read-only Kobra X native report; KobraLink path was unreachable without an owner bridge.

## Klipper checklist — owner steps not delegable to agents

From [HARDWARE-ACCEPTANCE-CHECKLIST.md](docs/HARDWARE-ACCEPTANCE-CHECKLIST.md):

- Grant **written authorization** for a physical test run (printers named, date, people present) before any step that touches hardware.
- Provide **two Klipper printers** on the private LAN (or accept partial acceptance with comparison steps N/A).
- Configure **private** farm origin, Connector data dir, Moonraker/Spoolman/camera origins, and server pause-authority settings; keep secrets out of the repo (sections 1, 3, 8, Appendix A).
- **Approve** Connector pairing and browser device keys in the owner UI (sections 2, 4).
- **Supervise** sacrificial prints and signed pause (sections 0, 5, 8): physical presence, emergency stop, no automation.
- **Record** evidence in a private folder (section 15); share only a redacted summary on [#9](https://github.com/bloodf/Open3DFarmManager/issues/9) or a linked PR.
- **Manual recovery** for pause journal lockout and rollback when stop criteria or failures occur (sections 8, 14).

## Deployment, DNS, credentials, production

Per [AGENTS.md](AGENTS.md): deploy, change DNS or credentials, and start production services only with **separate owner authorization** (not implied by merge or CI).

## Publication authorization

Per [AGENTS.md](AGENTS.md) and [IMPLEMENTATION-QUEUE.md](docs/IMPLEMENTATION-QUEUE.md): the existing **local payload** still needs explicit owner **publication authorization** after review for private material, secrets, and licenses.

**Held vendor emitters** (staged by driver teams, pending browser-first rollout): owner authorization to publish when ready, including the Creality LAN alert emitter and Kobra 3 speed/clog alert emitters.

## Optional read-only qualification

Owner may run [`scripts/qualify-printer.ts`](docs/QUALIFY-PRINTER.md) on additional LAN printers to add reports under [docs/hardware-reports/](docs/hardware-reports/README.md); agents must not command hardware in tests.
