# RTC assignment binding source checkpoint

This source slice adds strict read-only RTC binding v2. Acceptance is pending.
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
passed for the coherent TS/Markdown paths. Full integration, migration execution,
full checks and actual RTC acceptance remain pending their separate windows.
The genuine authenticated fixture helpers have no locally fabricated v1 binding
or proof envelope. They pass complete refs to maintained wrappers and require
real server admission. They therefore need an authoritative v2 server artifact;
the separately frozen v1 artifact is not an acceptance substitute. Historical
browser/native and finite-media fixtures omit genuine status and retain v1.
Historical finite-video evidence is unchanged. Native binary provenance and
the earlier unresolved legitimate-SDP ICE observation remain limitations.
