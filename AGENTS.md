# Development rules

- This is an independent MIT project. Write original code. Check dependency licenses; retain required notices.
- Private hosting configuration, account identifiers, credentials and the original private planning documents stay outside this repository.
- Use independent accounts, a host-only session cookie and a dedicated database. Never reuse another product's session or secrets.
- Phase 0 and v1 target Klipper/Moonraker and Spoolman. Build and test with simulators before hardware.
- Live status, camera and signed commands travel over browser-to-Connector WebRTC. No TURN or HTTP/server command fallback. Degraded mode is read-only.
- Keep safety enforcement in the Connector, including during server outages. Never send commands to physical printers during automated tests.
- Work on feature branches and draft PRs. Do not merge, deploy, change DNS/credentials or start production services without authorization.
- Internal Codex agents managed by this session or T3 Code, and Google Gemini 4 Argon and Gemini 3.8 Flash agents through configured T3 Code providers, are authorized for development, subject to available quota and runtime concurrency limits. Do not use external chats or other external AI agents without separate explicit approval.
- Use Bun workspaces, Nuxt 4 and TypeScript. Run `bun run check:all` before publishing changes; report pending integration checks explicitly.
- Commit one coherent subtask at a time using English conventional commit messages. User-facing copy is pt-BR and accessible.

## Disk space and task cleanup

- Before builds, container tests or simulator runs, inspect free disk space, Git status, worktrees and existing test resources. Record the baseline and task-owned resource names/IDs in a local task ledger outside the repository. Include temporary directories, generated output, containers, images, volumes, networks and any worktrees created for the task. Keep private paths and operational details out of committed reports.
- Reuse a compatible healthy simulator when safe. Coordinate ownership before sharing it; never reset, stop or delete another task's instance. Start additional instances only when isolation or the test requires them, and record why. Do not leave duplicate idle simulators running.
- Check space again before large pulls/builds or concurrent runs. Account for image layers, build cache, volumes and logs, not just the checkout. If capacity is insufficient, stop new heavy work and remove only verified disposable task-owned resources. Never use broad prune commands or delete global caches or other projects' data.
- At task completion, stop task-owned processes and simulators. Remove disposable task-created containers, volumes, networks, temporary files and generated build/test output once no active work needs them. Remove a task-pulled image only when it was absent from the baseline and no other task needs it. Do not remove pre-existing `dist`, dependencies, caches or outputs without verifying ownership and whether they are still needed. Retain diagnostic evidence for unresolved failures in one bounded local evidence directory; report its location and purpose.
- Before removing a worktree, verify its status including untracked files, confirm no active task uses it, and verify that its commits are merged into the intended target or durably preserved elsewhere. A merged PR alone is insufficient if later local commits exist. Never force-remove worktrees, discard uncommitted data or delete unpushed branches. Remove only task-owned disposable worktrees; ask before removing pre-existing ones.
- Finish with a resource audit. Report what was removed, what remains and why, disk availability, and any cleanup blocked by ownership or active use. Never describe unrelated Docker resources or old branches as disposable merely because they appear idle.

## Capacity planning

- The owner requests at least ten agents working concurrently whenever sufficient independent work, quota and runtime capacity are available. Use the maximum useful concurrency permitted by the actual runtime; never bypass its limit or claim queued agents are running. Report any shortfall and its cause. Do not duplicate work or manufacture tasks to meet a headcount.
- Keep a queue of bounded independent tasks with explicit acceptance conditions. While a worker waits on a dependency, continue other authorized work and reassign available capacity. Wait only when no useful independent work remains; do not bypass required approvals or safety gates to avoid waiting.
- Consult T3 Code's available account and quota information before distributing work across the owner's configured Codex and authorized Google model providers. Select only authorized configured instances with sufficient reported capacity; preserve the current coordinator's configuration. Do not invent quota estimates or claim that separate subscriptions form a shared quota pool. If remaining quota is not exposed to the agent, report that limitation and avoid unnecessary parallel work.
- Every worker must receive the resource-ownership and cleanup rules with its task, record its own resources, and return a cleanup report. Assign distinct file ownership or isolated checkouts, and tell workers to preserve other agents' edits. The coordinating agent checks those reports before declaring the work finished. Agents outside the authorization above still require separate approval.
