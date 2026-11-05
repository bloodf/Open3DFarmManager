# Focused review of the local integration

Reviewed baseline: `f32bdf1`, on the local integration branch. This is a code review with targeted regressions, not an independent audit or production acceptance.

## Reviewed boundaries

- `packages/farm-protocol/src/sign.ts`, `command.ts`, `canonical.ts`, `encoding.ts` and `json.ts`: signed payload construction, canonical serialization, bounded decoding and duplicate fields.
- `packages/connector/src/auth/verify.ts` and `replay.ts`: scope checks, signature verification before replay admission, transactional persistence and filesystem preflight.
- `packages/connector/src/identity/store.ts`: private-key loading, permissions, publication and error handling.
- `packages/connector/src/cloud/queue.ts`: storage ownership, append descriptors, compaction recovery and interrupted logs.

## Confirmed findings and changes

1. Malformed identity or telemetry JSON could make the native parser include file contents or excerpts in a thrown error. The CLI already masked its errors, but the library boundary did not. Both storage readers now return fixed JSON-format errors. A synthetic marker reproduced the disclosure before the fix and is absent afterwards.
2. When the main telemetry log was absent but a compaction candidate existed, startup created an empty log and removed the candidate. It now refuses initialization and preserves the candidate for explicit recovery. No automatic choice between potentially valid states is made.
3. Append opened a replacement hard link without checking the opened descriptor, allowing data to be written to the linked target. The descriptor is now checked for regular-file type, single link, owner and private permissions before writing. Recovery reads and truncation also validate their descriptors. This reduces accidental/path-substitution hazards; a hostile same-account process remains outside the storage trust model.
4. Identity loading opened a path before validating its type, allowing a FIFO to block indefinitely. Nonblocking, no-follow opens now let descriptor validation reject the FIFO. The queue's descriptor-based reads use the same nonblocking protection. Timed subprocess tests reproduced blocking and now exit promptly.

An additional preflight gap skipped dangling SQLite sidecar symlinks because `existsSync` follows links. SQLite itself rejected the tested case; no successful redirection was demonstrated. Preflight now uses `lstat` presence checks so unsafe sidecars are rejected before SQLite opens them.

## Verification and scope

`tests/node/security-regression.test.ts` contains eight tests. Four initial checks failed before their fixes; the FIFO subprocess test and the telemetry-error disclosure test also failed before nonblocking opens were added. Additional positive checks verify that a freshly signed copy of an already claimed command is still rejected after restart, escaped duplicate fields never reach replay storage, and four OS processes produce one accepted claim and three replay rejections.

The complete local suite passes with 122 Bun tests and 37 Node tests, plus type checking, formatting and production builds. These tests use synthetic keys and disposable directories only. The two Chromium checks also passed and cover browser signing and hidden-route behavior, not real device control.

## Remaining risks and decisions

No authenticated pairing service, trustworthy authorization-context delivery, WebRTC command transport or physical dispatcher is implemented. Browser nonextractability does not prevent hostile same-origin scripts from requesting signatures. The provisional authorization lease is not a decision about offline operation or revocation.

Filesystem checks assume trusted parent paths and no hostile process with the same OS account. This review does not establish resistance to all path races, disk rollback, backup restoration, hardware failure or power loss. A restored replay database can lose later claims; no tamper-resistant monotonic storage is supplied. Stale initialization locks and ambiguous pending identity/queue files require controlled recovery. POSIX owner/mode tests do not establish Windows ACL security.

No CI gates were changed, no container was started, and no remote repository publication or real device action occurred during this review.
