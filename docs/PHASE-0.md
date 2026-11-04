# Phase 0 acceptance ledger

This independent MIT repository supersedes the former monorepo destination. Accounts, session cookies and database belong to this product. Hosting-specific details remain private. No code from the former application has been copied.

## Sequence

1. E0.1: isolated Klipper simulators (single and four tools), Spoolman seed, cameras, network faults and integration CI.
2. E1.1: Bun workspaces, Nuxt 4, protocol contracts, Connector CLI, checks, Docker packaging and feature flags.
3. E1.2: dedicated Postgres 17, reversible migrations, validated environment, readiness, structured logs and portable Compose.
4. E2.1/E2.4: independent login and session, authorization, rate limits and secure Connector pairing.
5. E3.1/E3.2: Connector identity, configuration, durable offline queue and batched persistence.
6. E5.1a/E5.4a: Moonraker identify/subscriptions/webcam and read-only Spoolman mirror.
7. E2.3/E4.1–E4.5: approved browser keys, WebRTC spike, authenticated signalling, signed commands, local verification and read-only degradation.
8. E6.1: hidden farm view with age indicators and direct links to existing printer UIs.
9. Hardware acceptance is an owner-run gate after simulator acceptance. Deployment and physical printer control require separate authorization.

## Invariants

- No TURN, cloud slicing, server-enqueued commands or command fallback outside WebRTC.
- Connector enforces signatures, roles, expiry, replay protection and safety when the server is unavailable.
- Camera/video and bulk files stay on P2P transport. Server receives bounded snapshots and batched metadata only.
- Simulators never connect to physical printers. Four-tool fixtures approximate capabilities, not unverified vendor internals.
- Do not mark Phase 0 complete until login, pairing, signed pause, tamper/replay/revocation rejection, outage recovery and degraded mode pass integration and browser tests.

## Current acceptance checks

| Gate                                            | Check                                            | Status          |
| ----------------------------------------------- | ------------------------------------------------ | --------------- |
| Workspace dependencies                          | `bun install --frozen-lockfile --ignore-scripts` | Pending         |
| Type safety, unit tests, production build       | `bun run check:all`                              | Pending         |
| Browser smoke and hidden view                   | `bun run test:e2e`                               | Pending         |
| Connector distribution                          | `node packages/connector/dist/cli.js --version`  | Pending         |
| Simulator lifecycle and protocol responses      | `bun run sim:smoke`                              | Pending         |
| Docker packaging                                | local image build and health probe               | Pending         |
| Auth, database, pairing, WebRTC, offline safety | subsequent milestones                            | Not implemented |

`/healthz` initially reports process liveness only. Database readiness will be added with E1.2; it must not be interpreted as a complete deployment health check.

Local Docker integration is blocked: the configured Docker socket is absent. Compose validation passes, but no simulator/container execution is claimed. CI is prepared to run both image and simulator gates.
