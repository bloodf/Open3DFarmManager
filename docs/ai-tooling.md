# AI tooling

Product development is on HOLD until Heitor explicitly authorizes its resumption. Tooling checks, reviews and merges do not resume product work or authorize product PRs, deployment, DNS or credential changes. Follow the existing security, review and resource ownership rules in `AGENTS.md`.

## CodeGraph

The standalone CLI is pinned by `.codegraph-version`; it is not an application dependency. The reviewed 1.6.2 bundle can be installed on macOS or Linux by downloading and inspecting the installer at `https://raw.githubusercontent.com/colbymchenry/codegraph/f72c9d2efb14454ff4f9fd7b8460abd82f19a287/install.sh`, then running `CODEGRAPH_VERSION=v1.6.2 sh <downloaded-file>`. It requires `curl` and `tar`. Do not upgrade during feature work.

From the repository root:

```sh
sh scripts/codegraph.sh init --yes
sh scripts/codegraph.sh sync
sh scripts/codegraph.sh status --json
sh scripts/codegraph.sh query '<known symbol>' --limit 5 --json
sh scripts/codegraph.sh explore --max-files 3 '<narrow question or symbol names>'
```

Use the graph before broad source reads. Start with one to three files; use bounded text search for exact text, unsupported syntax or missing results. Verify relevant source and behavior independently. The graph does not prove runtime behavior or complete dynamic calls.

Each worktree needs its own index. The tracked `.codegraph/.gitignore` excludes local databases, logs, sockets and daemon state. Never copy indexes between worktrees or commit generated data. The MCP service watches changes only while active; the CLI route requires `sync` after checkout or edits. Re-run `index` after changing CodeGraph include, exclude or extension rules. Check `status --json` for completion and pending changes. Release 1.6.2 does not support `--strict`.

CodeGraph can install MCP configuration for Codex, Cursor and Antigravity through its CLI, but that changes user configuration and belongs to workstation setup, not this repository. Keep its default single `codegraph_explore` tool. Use the bounded CLI commands when MCP is unavailable, including for Grok or MiniMax.

## Other tools and routing

- RTK: follow `~/.codex/RTK.md`. With native hooks, run commands normally; without hooks, use supported `rtk` commands. Use `rtk bypass` only for unusable condensed output. Do not compress twice.
- Caveman and Ponytail: use native skills when available. Otherwise apply their principles manually: concise complete sentences, inspect callers, reuse existing code, and make the smallest complete verified change. Do not weaken safety, accessibility or tests.
- TokenEconomizer: use its repository learning, tool pruning and loop guidance only in supported harnesses. It is not a generic output compressor. Its suggestions never override user policy or required tools. Where unavailable, follow the same policy manually.
- Antigravity routes use Google models only. Argon remains parked while quota-exhausted. The central coordinator owns routing and capacity reservations; use only actual exposed authorized provider/model IDs, skip unavailable or exhausted routes, and do not invent quota or retry blindly. MiniMax M3.1 Flash requires the exact runtime-validated ID `m:minimax:MiniMax-M3.1-Flash:v:thinking`. The empty variant advertised by T3 fails with `Invalid model reasoning` because the runtime requires `FORCED_ON`; do not select a nonthinking variant. Keep mechanical tasks bounded and reserve frontier models for judgment and independent risky review. Unknown quota remains unknown.

No local token or cost savings have been measured. Limit graph output rather than assuming it reduces context.
