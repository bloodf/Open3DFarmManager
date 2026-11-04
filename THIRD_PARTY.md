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

Exact package versions and integrity values are in `bun.lock`. The simulator image is digest-pinned in Compose. Its software stays inside the external container; no upstream source/configuration is vendored. Follow upstream licensing if redistributing that image. Runtime Docker bases also retain their upstream notices.

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
