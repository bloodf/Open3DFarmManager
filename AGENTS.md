# Development rules

- This is an independent MIT project. Write original code. Check dependency licenses; retain required notices.
- Private hosting configuration, account identifiers, credentials and the original private planning documents stay outside this repository.
- Use independent accounts, a host-only session cookie and a dedicated database. Never reuse another product's session or secrets.
- Phase 0 and v1 target Klipper/Moonraker and Spoolman. Build and test with simulators before hardware.
- Live status, camera and signed commands travel over browser-to-Connector WebRTC. No TURN or HTTP/server command fallback. Degraded mode is read-only.
- Keep safety enforcement in the Connector, including during server outages. Never send commands to physical printers during automated tests.
- Work on feature branches and draft PRs. Do not merge, deploy, change DNS/credentials or start production services without authorization.
- Do not use external chats or delegate development to agents.
- Use Bun workspaces, Nuxt 4 and TypeScript. Run `bun run check:all` before publishing changes; report pending integration checks explicitly.
- Commit one coherent subtask at a time using English conventional commit messages. User-facing copy is pt-BR and accessible.

For repository AI tooling, version pinning, fallback commands and the current product HOLD, see [docs/ai-tooling.md](docs/ai-tooling.md).
