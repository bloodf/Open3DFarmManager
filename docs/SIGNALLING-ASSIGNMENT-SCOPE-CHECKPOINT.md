# Assignment-bound signalling server source checkpoint

Focused Node and Bun checks each passed 81 tests with two runtime skips. Scoped strict TypeScript and formatting passed. Official migration application/reversal, restart and PostgreSQL acceptance have not run for this addition. It supplies no integrated status or hardware acceptance.

## Authority and transport

The authoritative browser-context reader retains existing account/session expiry, membership, approved browser key, approved enrollment, credential/revocation and final-time checks. After the existing enrollment SHARE and credential SHARE locks are held, it reads the complete active assignment set for the exact farm and agent. The query accepts no caller assignment subset and uses LIMIT 17 to deny empty sets and sets exceeding the supported 16. Exact immutable assignment IDs and PostgreSQL-representable keys are validated before shared assignmentSetDigest computation inside the transaction. Final session/time checks still occur after that asynchronous work, and the read budget still includes COMMIT elapsed time.

The authority snapshot includes assignment_count and assignment_digest. The coordinator requires these strict fields, includes both in its existing canonical identity pins and recomputes current authority on every existing revalidation. New production bindings are strict v2 with these pins; no missing-pin or mismatched-pin path downgrades status to v1. Connector inbox identity discovery remains assignment-independent until a browser context is requested. No full assignment list, command authority or credential is exposed by these two digest fields.

Existing original authentication deadlines and the at-most-30-second partition lease are unchanged. Five-second current-state rechecks are opportunistic and can only shorten or close the context. They do not constitute a renewable freshness heartbeat or promise immediate revocation while a peer is partitioned. SDP/DTLS, role proof, native local deadlines and strict complete-message checks remain independent requirements.

## Locking and privileges

Migration 0019 grants only SELECT on printer_assignments(id,farm_id,agent_id,printer_key,revoked_at) to the existing non-login signalling reader. It grants no assignment UPDATE, INSERT, DELETE, TRUNCATE, general SELECT, new role or security-definer capability. Down revokes these columns without deleting assignment identities/tombstones. An assignment-bound read then fails closed; down does not reinterpret a binding as v1.

The maintained printer ownership register/revoke operations take enrollment UPDATE before reading or changing assignments. Holding enrollment SHARE through the complete read, digest and final checks serializes with those maintained writers, including an initially absent assignment. No assignment-row UPDATE grant or predicate lock is claimed. Trusted direct SQL through farm_printer_ownership can bypass the maintained lock sequence; this is an explicit writer trust assumption, not an enforcement guarantee against arbitrary SQL using that role. Strengthening the writer boundary would require a separate reviewed change.

## Prepared evidence and remaining gates

Coordinator fixtures now carry digest/count and assert strict v2 output. Prepared negative cases deny missing pins and close on changed count or digest. The PostgreSQL helper provisions a default assignment through the maintained ownership API and compares actual reader pins to the shared digest. Additional prepared groups cover five-column visibility and forbidden reads/mutations; empty, 17-row and 16-row Unicode sets; real enrollment contention in both reader-first and writer-first orders for initially empty insert and revoke; same-key replacement with a new immutable ID; and an explicit direct-writer bypass demonstration. New gates drain lock holders/readers/writers and close their dedicated fixture pool even on failure.

The PostgreSQL cases remain UNRUN. The maintained reader runner now requires the official contiguous catalog through 0019, including actual 0018. No migration history may be fabricated or manually backfilled. Required acceptance includes up/down/up privileges and checksums, current session/credential expiry and restart regressions, actual lock races, cross-runtime digest vectors, no downgrade, local-list mismatch, exact complete frame limits and then one genuine built HTTPS/WSS/RTC synthetic-printer flow. No physical command is authorized.

No dependencies, processes, ports, containers, clusters, worktrees or generated outputs were created by preparing this source. Other protocol, peer, client, identity and runtime changes belong to the coordinating WebRTC worker and were preserved. No publication, deployment or runtime integration is claimed.
