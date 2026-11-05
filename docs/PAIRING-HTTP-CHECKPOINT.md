# Pairing HTTP acceptance checkpoint

This checkpoint is scoped to the exact contiguous catalog ending at `0012_connector_inventory`; it must be reviewed and updated against later committed catalog changes before any run. The HTTPS acceptance fixture is opt-in and requires a disposable loopback PostgreSQL database named `fixture`, accessed by the synthetic `fixture` administrator. The caller must apply the complete official migration catalog through `0012_connector_inventory` and own database teardown. The helper checks the migration journal and does not alter it. Build the current app first, then run:

```sh
PAIRING_HTTP_SYNTHETIC_TEST_DISPOSABLE=yes \
PAIRING_HTTP_SYNTHETIC_TEST_PORT=<loopback-port> \
PAIRING_HTTP_TEST_LEDGER=<absolute-task-ledger-path> \
bun scripts/test-pairing-http.ts
```

The helper creates separate restricted login roles, synthetic accounts and farms, an ephemeral local HTTPS proxy, and temporary signing and TLS keys. It trusts the generated certificate for Node through `NODE_EXTRA_CA_CERTS`, runs Chromium against the built application, and tears down its roles, processes, and temporary files. Synthetic database rows remain in the caller-owned disposable database. The ledger records resource names and cleanup status without credentials.

The prepared test covers native Node fetch and controlled machine requests, browser login and approval, proof replay, wrong farm and fingerprint, claim racing, JWT signature and binding, inventory recovery, exact-row revocation, fresh pairing, a deferred credential commit failure and retry, and selected request boundary failures. A fixture-only proxy control drops a successful claim response after its upstream response completes, then the test discovers and revokes the exact enrollment before pairing again. It also prepares admin and operator decisions, expired and revoked session denials, a real-clock proof deadline, and membership revocation while an HTTP approval waits on its database lock. Browser request and response bodies and storage are checked in memory for Connector private key, device code, and received JWT values. No physical device is used.

This is a prepared acceptance fixture, not an acceptance receipt. Runtime execution against the isolated database is pending. The synthetic expired session is issued through the real restricted credential repository and sealed with Nuxt's installed session primitive; the primary login uses the built application. The HTTP request matrix still requires the live run to establish the actual outcome, and test artifacts and failure paths require inspection during that run. The existing storage tests do not establish those HTTP results. A passing subset must not be reported as full pairing acceptance.

The prepared path reaches the shared pairing limiter at most 59 times, including denied requests; boundary rejections before the limiter are excluded. It does not reset the limiter.
