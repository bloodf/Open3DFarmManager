# Implementation queue

This queue describes the independent MIT project. It excludes private deployment configuration, accounts, credentials and planning documents. Checkpoint documents record evidence for specific components; Phase 0 remains incomplete.

## Current evidence and state

- Local integration at `1d67067` passed 213 Bun tests, 105 Node tests and 17 Playwright tests. A separate browser/WebRTC experiment passed seven Chromium scenarios. These results are tied to those exact heads and do not establish full product acceptance.
- The audit fix at `6bbf3ec` passed its 23 focused tests and type checks. Full integrated CI after that fix and subsequent changes is pending. The bounded Klipper failure collector is now present locally at `2f7275d`; it records bounded diagnostics while preserving the original failing exit status.
- Pairing proof and credential issuance are validated through focused PostgreSQL helpers on disposable clusters with their recorded migrations. Credential delivery after an ambiguous commit, automatic orphan cleanup, authenticated HTTP approval/claim endpoints and current online Connector revocation remain incomplete. See [pairing proof](PAIRING-PROOF-CHECKPOINT.md) and [credential issuance](CONNECTOR-CREDENTIAL-ISSUANCE-CHECKPOINT.md).
- Local commits and successful local checks are not published or merged releases. The full 267-file publication review is running against immutable commit `6bbf3ec`; the existing local payload still requires explicit publication authorization.

## Active work and dependency order

1. Complete the Connector revocation and recovery slice using migration `0011`. Preserve immutable identity and credential records, define recovery after known and ambiguous failures, and verify migration history and rollback through the official runner on a disposable database.
2. Complete farm discovery and Connector inventory as migration `0012`, with least-privilege reads, a farm-scoped GET route and the corresponding read-only interface. Base access on the current authenticated session, membership and revocation state. Verify wrong-farm, revoked-session, role and missing-resource cases against PostgreSQL before integrating the view.
3. Complete actual Node/Bun Connector interoperability for the WebRTC path. The seven-scenario Chromium experiment is supporting evidence only. Verify browser-to-Connector identity binding and live data transport in both runtimes; retain the no-TURN and no HTTP/server command-fallback rules.
4. After these slices settle on one candidate head, run the focused checks and then the full integrated CI required for that head. Include the collector tests and ensure Klipper diagnostics preserve failures instead of converting them into passes.

The above work can proceed in parallel only where file ownership and dependencies permit. Do not call a source commit integrated until its content is present on the target branch; telemetry replay commit `37b0c73` was integrated by cherry-pick `8fa5a11`, so source-branch ancestry is not sufficient evidence. The telemetry worktree outputs and proxy processes remain outside cleanup scope while their use is unknown and a previous cleanup attempt was blocked.

## Phase 0 acceptance still required

Simulator acceptance is blocked by unresolved SV06/Klipper startup. The current diagnostic evidence includes a native ARM64 single-printer control that stayed in `startup` through the 90-second window. Aggregate CPU throttling was measured in a separate run but does not establish the cause. Public PR #10 at head `908c057` has five successful checks and one Klipper readiness failure at 90 seconds; it is not merged. Do not relax readiness, timing or safety limits based on these results. Full acceptance still requires the existing two-printer, four-tool, camera and read-only Spoolman scenarios, repeated on required architectures with bounded evidence and negative-fault coverage. See the [simulator follow-up](SIMULATOR-ACCEPTANCE-FOLLOWUP.md), [evidence summary](SIMULATOR-EVIDENCE-SUMMARY.md) and [CI diagnostics](KLIPPER-CI-DIAGNOSTICS.md).

After the simulator gate, end-to-end acceptance must connect independent login, authorized farm approval, pairing, credential delivery and revocation, actual browser-to-Connector WebRTC, authenticated telemetry recovery and Connector-local command safety. Define and verify the offline authorization lifetime and fail closed at expiry. Exercise signature tampering, replay, stale or revoked authorization, wrong role and farm scope, server/database outage and read-only degradation in the built app and browser. Automated tests must use simulators only; no physical printer commands.

The current [Phase 0 ledger](PHASE-0.md) and [integration checkpoint](INTEGRATION-CHECKPOINT.md) describe earlier milestones and remain useful historical evidence. Update them only when new acceptance evidence changes their recorded state.

## Later product work

Once the integrated core passes, finish Moonraker discovery, configuration, history, metadata and tool reporting, keeping Spoolman as a read-only inventory source. Then add job costing and traceable material use, maintenance, inventory, quotes/orders and notifications with farm-scoped access. Packaging, installation/update guidance, synthetic backup/restore, retention and operational diagnostics also remain. Additional printer families require their own simulators and licensing review.

## Completion and publication gates

- Track each behavior as local, validated, published or merged, with the exact commit or PR head. A successful component helper does not prove end-to-end acceptance.
- Run `bun run check:all` on the final candidate head, then required disposable PostgreSQL, browser/WebRTC and simulator checks. Report any pending integration or remote CI explicitly.
- Review the immutable publication diff for private material, secrets and license obligations. Do not publish the existing local payload until its separate explicit authorization is granted. Deployment, DNS or credential changes and physical-printer tests require separate authorization.
- At task end, report cleanup ownership. Preserve other tasks' resources and evidence; do not remove telemetry outputs or proxies until ownership and active use are resolved.
