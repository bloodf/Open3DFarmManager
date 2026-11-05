# Pairing HTTP acceptance checkpoint

The HTTPS acceptance fixture is opt-in and requires a disposable loopback PostgreSQL database named `fixture`, accessed by the synthetic `fixture` administrator. The caller must apply the complete official migration catalog through `0012_connector_inventory` and own database teardown. The helper checks the migration journal and does not alter it. Build the current app first, then run:

```sh
PAIRING_HTTP_SYNTHETIC_TEST_DISPOSABLE=yes \
PAIRING_HTTP_SYNTHETIC_TEST_PORT=<loopback-port> \
PAIRING_HTTP_TEST_LEDGER=<absolute-task-ledger-path> \
bun scripts/test-pairing-http.ts
```

The helper creates separate restricted login roles, synthetic accounts and farms, an ephemeral local HTTPS proxy, and temporary signing and TLS keys. It trusts the generated certificate for Node through `NODE_EXTRA_CA_CERTS`, runs Chromium against the built application, and tears down its roles, processes, and temporary files. Synthetic database rows remain in the caller-owned disposable database. The ledger records resource names and cleanup status without credentials.

The test covers native Node fetch and controlled machine requests, browser login and approval, proof replay, wrong farm and fingerprint, claim racing, JWT signature and binding, inventory recovery, exact-row revocation, fresh pairing, a deferred credential commit failure and retry, and selected request boundary failures. Browser output is checked for the Connector credential and device code. No physical device is used.

This is a prepared acceptance fixture, not an acceptance receipt. Runtime execution against the isolated database is pending. The HTTP matrix still needs explicit deadline and lock-wait races, admin and operator decisions, revoked and expired sessions, complete origin/content/parameters cases, and confirmation that all browser traffic and artifacts exclude Connector private material. The existing storage tests do not establish those HTTP results. A passing subset must not be reported as full pairing acceptance.
