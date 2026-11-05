# Pairing HTTP acceptance checkpoint

This checkpoint is scoped to the exact contiguous catalog ending at `0014_connector_credential_proofs`; it must be reviewed and updated against later committed catalog changes before any run. The HTTPS acceptance fixture is opt-in and requires a disposable loopback PostgreSQL database named `fixture`, accessed by the synthetic `fixture` administrator. The caller must apply the complete official migration catalog through `0014_connector_credential_proofs` and own database teardown. The helper checks the migration journal and does not alter it. Build the current app first, then run:

```sh
PAIRING_HTTP_SYNTHETIC_TEST_DISPOSABLE=yes \
PAIRING_HTTP_SYNTHETIC_TEST_PORT=<loopback-port> \
PAIRING_HTTP_TEST_LEDGER=<absolute-task-ledger-path> \
node scripts/test-pairing-http.ts
```

The helper creates separate restricted login roles, synthetic accounts and farms, an ephemeral local HTTPS proxy, and temporary signing and TLS keys. It trusts the generated certificate for Node through `NODE_EXTRA_CA_CERTS`, runs Chromium against the built application, and tears down its roles, processes, and temporary files. Synthetic database rows remain in the caller-owned disposable database. The ledger records resource names and cleanup status without credentials.

The prepared test covers native Node fetch and controlled machine requests, browser login and approval, proof replay, wrong farm and fingerprint, claim racing, JWT signature and binding, inventory recovery, exact-row revocation, fresh pairing, a deferred credential commit failure and retry, and selected request boundary failures. A fixture-only proxy control drops a successful claim response after its upstream response completes, then the test discovers and revokes the exact enrollment before pairing again. It also prepares admin and operator decisions, expired and revoked session denials, a real-clock proof deadline, and membership revocation while an HTTP approval waits on its database lock. Browser request and response bodies and storage are checked in memory for Connector private key, device code, and received JWT values. No physical device is used.

This is a prepared acceptance fixture, not an acceptance receipt. A complete passing integrated run against the isolated database remains pending. The synthetic expired session is issued through the real restricted credential repository and sealed with Nuxt's installed session primitive; the primary login uses the built application. The HTTP request matrix still requires the live run to establish the actual outcome, and test artifacts and failure paths require inspection during that run. The existing storage tests do not establish those HTTP results. A passing subset must not be reported as full pairing acceptance.

The final prepared phase obtains a fresh owner session and proof, exhausts the anonymous machine quota, sends anonymous browser mutations, and checks that authorized approval and exact-target revocation still appear in inventory. The test does not reset rate limits. An outer deadline bounds Chromium and fixture cleanup; a sanitized failure receipt is retained in the task evidence location.

A separately authorized `PAIRING_HTTP_TEST_PHASE=remaining` run selects only the expiry, revoked-session, and exhausted-quota recovery gates. It is meaningful alongside the earlier recorded full-run evidence; it does not establish an uninterrupted full run. The default fixture continues to select the full matrix.

## Local acceptance status

**HOLD:** no uninterrupted end-to-end run has passed. A local HTTPS/Chromium run of the built app at source `8352a1e` with test head `04dbae8` reached the proof-expiry check after exercising login, approval, credential claim, deliberately dropped claim response, inventory recovery, revocation, fresh pairing, role checks, the membership lock race, and deferred commit failure. That run failed an incorrect expectation that the claim response for an unapproved request with an expired proof must be non-2xx. The assertion was corrected to require the existing `pending` response and zero credential rows.

An explicitly authorized remaining-phase run at test head `e069199` timed out. Read-only database observations after that timeout included a pending request with an expired-proof marker and no credential, and an approved enrollment recorded as revoked after the anonymous machine limit had been reached. Those individual observations are not a passing continuation or evidence that every final browser assertion completed. The timeout cause remains unknown. First failure receipts and a bounded sanitized database snapshot were retained outside the repository.

The `8352a1e` application build's server entry SHA-256 was `6d122793380f4fd694d415f11501c91c4e43af48ae9c4df82cbba2393c1c1c74`; its Nitro chunk SHA-256 was `50aee6fd5acf74b9ec971b896c9ffa02eb8efba82a56710442d69fb9eb9735dc`. The independent credential-acceptance storage change at `ed32387` was not included in that app build; its PostgreSQL helper separately passed 12 groups against the official catalog through `0014`, without changing the HTTP rate-limit rows. The full `8352a1e` source check passed 225 Bun and 110 Node tests and both builds; later test-only heads received focused checks only.

The local task-owned PostgreSQL cluster and HTTPS test resources were removed after the hold snapshot. The pre-existing PostgreSQL instance remained available and its first six official migration journal entries validated on a read-only connection. The original pre-task journal was not snapshotted, so this is not a byte-for-byte baseline comparison. A future integrated gate must rerun the complete HTTPS matrix on its exact current build and catalog. The current 60-second proof policy remains unchanged.

A future policy proposal could retain the verified identity during a bounded human approval and require a separate fresh claim-specific proof before issuance. That would require coordinated protocol and storage work and is not implemented.

The bounded stage and response-capture diagnostics currently apply to the optional remaining-phase test only; the default full matrix does not yet use them. A stalled or failed capture must fail the diagnostic run.
