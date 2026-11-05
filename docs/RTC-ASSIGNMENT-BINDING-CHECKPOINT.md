# RTC assignment binding source checkpoint

This slice adds strict read-only RTC binding v2. PostgreSQL and authenticated
HTTPS/RTC fixture acceptance passed at the revisions recorded below. Production
Moonraker status composition and full Phase 0 acceptance remain pending.
The separate built artifact at `959d4ef` predates this change.

`packages/farm-protocol/src/rtc-assignment-set.ts` hashes a complete candidate set
of 1..16 assignments. The canonical input includes the domain
`open3dfarmmanager:rtc-assignment-set:v1`, version 1, farm UUID, agent UUID and
assignment UUID/exact printer-key pairs sorted by lowercase assignment UUID.
UUIDs are validated with the maintained UUID schema after lowercasing. Keys use
the Connector PostgreSQL UTF8 contract: 1..128 UTF16 units, no NUL or isolated
surrogates, with no Unicode normalization. Duplicate IDs or exact keys, foreign
agents and additional tuple properties are rejected. The canonical UTF8 input
is capped at 16384 bytes. Sixteen maximally escaped keys fit this cap.

Binding v2 adds `assignment_count` and `assignment_digest`. Its proof envelope
has version 2 and signs `Open3DFarmManager/rtc-session-proof/v2`, NUL, peer role,
NUL and the canonical binding. Version 1 retains its original schema, envelope
and signature bytes for fixture/diagnostic callers. A genuine-status caller
requires version 2. It cannot negotiate or fall back to v1 after a mismatch.
Proofs remain capped at 8192 bytes, signalling frames at 12288 bytes and complete
status frames at 2048 bytes. Sixteen assignments do not imply every complete
status snapshot fits the application limit. Oversized snapshots fail closed.

Both authenticated wrappers and the shared RTC proof session independently
compare their copied candidate refs against the authenticated binding before
verified admission. The browser feed independently compares the same digest;
the Connector sender checks it before opening a snapshot provider. Async digest
completion rechecks terminal state and the original deadline. Candidate refs
alone never establish server authority. No tuple-transfer message is added.

Authoritative server emission, current-assignment queries, migration 0019 and
their PostgreSQL acceptance are separately owned by root. No server authority
is synthesized by this source slice. An equal printer key with a replacement
assignment UUID produces a different digest and requires fresh admission.

The original fixed lease of at most 30 seconds remains the maximum revocation
bound during a partition. Online server checks around five-second intervals
may close earlier. They provide no new five-second partition guarantee.
There is no renewable heartbeat, lease renewal or immediate offline revocation.
Commands remain disabled for every identity.

Focused tests cover scoped canonical vectors, UUID case/permutation,
Unicode distinctions, invalid keys, duplicate/foreign assignments, count and
maximum escaped shape, v1 byte preservation, v2 envelope/domain separation and
genuine-status downgrade/replacement denial. On Node 24.20.0 and Bun 1.4.2,
the eleven focused suites passed 81 tests with two actual-runtime skips each.
Scoped strict TypeScript passed after correcting a root-owned PG test assertion
that treated an already-defined Promise as a condition. Installed formatting
passed for the coherent TS/Markdown paths. Later integration evidence follows.
The genuine authenticated fixture helpers have no locally fabricated v1 binding
or proof envelope. They pass complete refs to maintained wrappers and require
real server admission. They therefore need an authoritative v2 server artifact;
the separately frozen v1 artifact is not an acceptance substitute. Historical
browser/native and finite-media fixtures omit genuine status and retain v1.
Historical finite-video evidence is unchanged. Native binary provenance and
the earlier unresolved legitimate-SDP ICE observation remain limitations.

## Integrated acceptance

At `ea741f57f0abb3bad91f7533c13840157dddad13`, `check:all` passed:
325 Bun tests, 374 Node tests with two runtime skips, lint, TypeScript and both
builds. The disposable PostgreSQL 17.11 fixture passed the maintained assignment
authorization suite, exact official 19-migration journal validation and 0019
down/up privilege checks. Contention assertions compare the returned assignment
IDs and exact digests after insertion and replacement. The earlier issuer
restart proof covered migration 0018; it is not a restart proof for 0019.

At `40e1a634556a280e7605e4cfcf3d2d21b9654903`, two separate generated HTTPS
fixture runs passed using the actual browser and Connector clients and native
RTC peers. Disconnect took 10.963 seconds; revocation took 13.769 seconds.
Both used real own-login, browser-key approval, Connector pairing credentials,
assignment registration and server-issued v2 admission. Both endpoints verified
their actual DTLS certificates and peer proofs before a complete status frame.
The transport-drop and owner-revocation cases closed the peers and provider
before natural lease expiry. Commands remained disabled.

The sealed server artifact contains 457 files, with output manifest digest
`35c06f5e8bdf02ba6ea94a284c0888f56efdfe798b95f2bcbd4ac23fcb15d5cc`.
The browser fixture ignores HTTPS certificate errors; the Connector trusts the
private fixture CA with certificate verification enabled. This proves the local
authority/transport integration, not production browser TLS deployment.
Status came from a finite synthetic provider under a real assignment, not from
Moonraker. Native buffering, binary provenance and RTSP remain separate gates.

Independent cleanup audits found all fixture children absent, app/proxy ports
closed, temporary login roles absent and TLS directories removed. The original
database identity, journal and eleven table counts matched its baseline. The
owned disposable PostgreSQL cluster and bridge remain retained for subsequent
integration work. Receipts stay outside Git in the private integrated-gate
ledger. After the browser URL correction, `check:all` passed with 325 Bun tests,
375 Node tests and two runtime skips, lint, TypeScript and both builds. This run
also included the fixture success-message correction and this checkpoint; only
this final results paragraph was added afterward.
