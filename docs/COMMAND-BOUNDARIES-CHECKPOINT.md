# Browser-to-Connector command rejection checkpoint

This E4.3.2/E4.3.3 test slice extends the existing persisted-browser-key signing flow to security rejections in the actual Node verifier and SQLite replay store. It adds tests rather than another interface or dispatch implementation. Application authorization behavior was not changed.

`tests/e2e/command-boundaries.spec.ts` bundles the actual browser key/signing modules locally. Chromium creates nonextractable P-256 keys in its isolated test profile and signs synthetic pause and emergency-stop commands. Node evaluates those signed messages with explicit synthetic context.

## Verified cases

- Eleven context variants for each of two signed actions: wrong farm, agent, user, session or key; unknown printer; revoked key; viewer role; expired authorization; oversized prototype authorization window; expired command. All 22 denials occur before calling replay storage. The original command subsequently remains eligible once.
- Changing the signed action or command ID invalidates the signature. Duplicate JSON keys, noncanonical whitespace, truncated JSON and oversized frames are rejected before claiming replay storage.
- The original valid command is accepted once, then remains a replay after closing and reopening the actual SQLite store.
- A closed replay store rejects a valid emergency-stop signature as storage unavailable. Reopening the store permits a first claim, confirming the failed attempt did not consume it.

Typecheck and all nine Chromium tests passed for this checkpoint. The existing 148 Bun and 54 Node tests and builds were last verified in the preceding ingestion checkpoint; they were not rerun for this test/documentation-only change. The browser suite still runs against the existing local build on loopback.

## Limits

These tests validate the verifier's handling of supplied trusted context, not its authenticity or freshness across an actual network. No real account, enrolled device, driver, physical printer, DataChannel or signalling server participates. Acceptance is an authorization decision, not evidence that an action executed.

The existing 60-second prototype authorization bound is tested as current code behavior, not selected as the final offline revocation policy. Revocation data is supplied directly in the test; remote propagation and outage behavior remain unimplemented. Nonextractability does not prevent hostile same-origin JavaScript from signing with an accessible key. No end-to-end production safety claim follows from this checkpoint.
