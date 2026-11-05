# Dependencies and references

The application and test utilities in this repository are original MIT code. No application code was imported from another print-farm project or private repository. Dependencies retain their own licenses; the root MIT license does not replace them.

| Component                                   | Use                          | License reported by package/project |
| ------------------------------------------- | ---------------------------- | ----------------------------------- |
| Nuxt, Vue, Vue Router                       | App runtime                  | MIT                                 |
| Zod                                         | Protocol validation          | MIT                                 |
| Effect                                      | Typed simulator I/O failures | MIT                                 |
| TypeScript                                  | Development                  | Apache-2.0                          |
| Bun type definitions, Node type definitions | Development                  | MIT                                 |
| Playwright                                  | Browser tests                | Apache-2.0                          |
| Prettier                                    | Formatting                   | MIT                                 |
| virtual-klipper-printer                     | Separate test container      | GPL-3.0                             |
| Spoolman                                    | Separate inventory simulator | MIT                                 |

Exact package versions and integrity values are in `bun.lock`. The simulator image is digest-pinned in Compose. Its software stays inside the external container; no upstream source/configuration is vendored. Follow upstream licensing if redistributing that image. Runtime Docker bases also retain their upstream notices.

## Pinned Spoolman provenance

Read-only registry and source review on 2026-11-04 verified the Compose reference `ghcr.io/donkie/spoolman@sha256:1405c3db0661cabf45209701f95304cf65f7db3b0f262dc824d32a1694fdf5fa`. The GHCR manifest and configuration blob were fetched with anonymous pull access and their SHA-256 hashes checked. No image layers were downloaded or upstream code executed.

| Artifact              | Verified metadata                                                         |
| --------------------- | ------------------------------------------------------------------------- |
| Pinned manifest       | OCI image manifest, linux/amd64                                           |
| Configuration blob    | `sha256:13edd8c5c34ed240a200bb88314cc78df6c6c3955aa5546c12df93a6140fd792` |
| Version label         | `0.27.1`                                                                  |
| Source revision label | `ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b`                                |
| License label         | MIT                                                                       |

The [LICENSE at that exact revision](https://github.com/Donkie/Spoolman/blob/ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b/LICENSE) is MIT and identifies **Copyright (c) 2023 Daniel Hultgren**. Copies or substantial portions must retain its copyright and permission notices. The root project license does not replace them; preserve the complete upstream license when redistributing covered material.

The [Dockerfile at that revision](https://github.com/Donkie/Spoolman/blob/ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b/Dockerfile) also includes a Python/Debian base, dependencies and built frontend assets. The MIT label does not describe every bundled component's license. Their complete inventory and notice inclusion inside the pinned image were not audited. Registry source labels are not signed build attestations; this review does not prove the image was built from the labeled source or independently reproduce its build. Review those obligations before redistributing the image. This repository references the external simulator without vendoring its implementation.

## Requested development references

Reviewed metadata and entry points on 2026-11-04. No skill installer, hook or third-party skill script was run. A skill's availability does not authorize external chats, subagents, credential access or deployment.

| Reference                                                                                                | Use in this milestone                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Ponytail](https://github.com/dietrichgebert/ponytail)                                                   | Small complete changes, boundary validation and explicit limitations                                  |
| [Stop Slop](https://github.com/hardikpandya/stop-slop)                                                   | Direct documentation and pt-BR copy                                                                   |
| [No AI Slop](https://github.com/petergyang/no-ai-slop), [Humanizer](https://github.com/blader/humanizer) | Editorial references reviewed; no files imported                                                      |
| [Unslop](https://github.com/heydamir/unslop)                                                             | UI guidance reviewed; no copied assets or skill text (CC BY 4.0)                                      |
| [Visant](https://github.com/pedrojaques99/visant-skills-public)                                          | Frontend/preflight entry points reviewed; broader design workflow reserved for actual product screens |
| [Cloudflare security audit](https://github.com/cloudflare/security-audit-skill)                          | Workflow reviewed; no complete audit claimed or external probing performed                            |
| [Unlazy](https://github.com/Leonxlnx/unlazy)                                                             | Completion discipline reviewed; checker/hooks not installed or executed                               |
| [Caveman](https://github.com/JuliusBrussee/caveman)                                                      | Concision guidance reviewed; no orchestrator used                                                     |
| [pstack](https://github.com/backnotprop/pstack)                                                          | Catalog reviewed; multi-agent and external tooling not used                                           |
| [Goldie](https://github.com/software-mansion-labs/goldie)                                                | App-store asset tooling; outside this web-app skeleton's scope                                        |
| [Effect](https://github.com/Effect-TS/effect)                                                            | Installed as a pinned dependency and exercised in simulator probe tests                               |

AGPL, BSL and FSL application sources are not copied into this MIT project. Future reuse requires inspecting the exact source revision and retaining all applicable notices.
