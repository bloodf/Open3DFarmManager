# Mac printer capability evidence

Checked 2026-11-23. Scope: exact printer models registered in the current catalog for Elegoo, Formlabs, Phrozen, Qidi, Flashforge and Prusa. Evidence is limited to official documentation and upstream/open-source implementations linked below. “Unverified” means neither that a capability is absent nor that a simulator proves device behavior. Protocol evidence, simulator evidence and hardware qualification are separate.

## Source register

| Key | Source and revision/retrieval | Evidence boundary |
|---|---|---|
| E1 | [Elegoo SDCP specification v3.0.0](https://github.com/elegooofficial/Saturn-4-Ultra/blob/main/SDCP%20(Device%20Control%20Protocol%29_V3.0.0_EN.md), retrieved 2026-11-23 | Protocol definitions do not establish model/firmware support. |
| F1 | [Formlabs PreForm API](https://developer.formlabs.com/api-reference/) and [quickstart](https://developer.formlabs.com/getting-started/quickstart/), retrieved 2026-11-23 | Host API and printer connection are different interfaces. |
| P1 | [OpenFarm Phrozen protocol notes](../protocols/phrozen.md), retrieved 2026-11-23; [Connector Phrozen adapter](../../packages/connector/src/phrozen/index.ts) | Adapter is synthetic/unqualified; not vendor proof. |
| Q1 | [QIDI Q1 Pro upstream repository](https://github.com/QIDITECH/QIDI_Q1_Pro), retrieved 2026-11-23; [Connector adapter](../../packages/connector/src/qidi/index.ts) | Moonraker fork evidence is for Q1 Pro only. |
| FF1 | [OpenFarm Flashforge protocol notes](../protocols/flashforge.md), retrieved 2026-11-23; [Connector adapter](../../packages/connector/src/flashforge/index.ts) | Adapter/simulator behavior does not qualify hardware. |
| PR1 | [OpenFarm Prusa protocol notes](../protocols/prusa.md), retrieved 2026-11-23 | Model-specific controls require matching PrusaLink/PrusaConnect documentation. |

## Catalog matrix

All entries below are catalog models. Capabilities not established by the cited exact-model sources are explicitly unverified.

| Family and exact catalog models | Protocol/version; authentication | Documented controls | Camera | Materials | Alarms and history | Evidence status / unverified behavior |
|---|---|---|---|---|---|---|
| Elegoo Saturn 4 Ultra; Saturn 4 Ultra 16K; Mars 5 Ultra | SDCP v3 definition exists (E1); per-model negotiation/authentication unverified | Adapter exposes read-only status only; print, stop, file and settings controls unverified | Not exposed; device capability unverified | Resin type/quantity unverified | Alarm taxonomy and durable history unverified | Synthetic status/simulator journey only per [catalog](catalog-resin.md); model/firmware hardware qualification pending. No simulator result establishes physical protocol support. |
| Elegoo Jupiter 2; Saturn 3 Ultra; Mars 4 Ultra; Saturn 2; Mars 3 Pro | Model-specific SDCP version and authentication unverified | Unverified; no qualified network adapter | Unverified | Unverified | Unverified | Catalog notes distinguish USB workflows on Saturn 2 and Mars 3 Pro from network support; USB does not prove network controls. |
| Formlabs Form 4; Form 4L | PreForm local host API; protocol version/authentication at printer boundary unverified (F1) | Host API workflow documented; individual printer controls unverified | Unverified | Material identity/remaining quantity unverified | Printer alarms/history unverified | Registered host status and simulator journey only; hardware behavior and observation timing unqualified. |
| Formlabs Form Studio 1 | Local API model support and protocol version unverified | Unverified | Unverified | Unverified | Unverified | No model-qualified adapter evidence. |
| Phrozen Sonic Mighty Revo 14K | SDCP-like implementation; V153 synthetic fixture for discovery/status; V138 positive evidence absent (P1) | Status only in fixture; other commands unverified | Unverified | Material quantity unverified | Alarm mapping/history unverified | Synthetic fixture only; no hardware qualification. |
| Phrozen Sonic Mighty Revo 16K MAX; Revo 16K; Mighty 8K; Sonic Mini 8K S | Exact-model protocol/authentication unverified | Network file workflow does not establish controls; others unverified | Unverified | Unverified | Unverified | No model-specific wire evidence; USB workflow for Mini 8K S does not establish network behavior. |
| Qidi Q1 Pro | Moonraker-derived API; authentication depends on device configuration; adapter handles unauthorized response (Q1) | Snapshot/status read path only in adapter; command operations unverified | Unverified | Filament/material sensors and quantities unverified | Alarm/history semantics unverified | Connector simulated status/recovery journey documented in REVIEW.md; no hardware qualification. |
| Other catalog Qidi models | Exact catalog model list is not evidenced in Q1 Pro upstream source; per-model protocol/authentication unverified | Unverified | Unverified | Unverified | Unverified | Do not generalize Q1 Pro implementation to other models. |
| Catalog Flashforge models | Protocol and version per exact model unverified in this evidence set; adapter authentication is configuration-specific (FF1) | Simulated status path only; control operations unverified | Unverified | Material/sensor quantities unverified | Alarm/history mapping unverified | Connector simulated status/recovery journey documented in REVIEW.md; no hardware qualification. |
| Catalog Prusa models | PrusaLink/Prusa Connect version and exact model coverage are not established here (PR1) | Unverified per exact model | Unverified | Material sensors/quantity unverified | Alarm/history semantics unverified | No model-qualified hardware evidence recorded. |

The current resin catalog lists the exact Elegoo, Formlabs and Phrozen rows above. The FDM catalog and fleet snapshot are the authority for Qidi, Flashforge and Prusa membership; where this matrix lacks a matching model-specific source, it deliberately records family scope as unverified rather than inferring support from a driver family. Protocol descriptions, synthetic fixtures and simulator journeys must not be reported as physical hardware qualification.
