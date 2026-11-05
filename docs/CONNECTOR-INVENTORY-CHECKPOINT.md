# Connector inventory verification checkpoint

The inventory endpoint lists farms visible to the signed-in account and the enrolled Connectors in a selected farm. It exposes only farm identifiers and Connector agent identifiers, fingerprints, and enrollment status. It is read-only and does not provide commands or live status.

The focused pagination test checks bounded limits, canonical cursors, repeated parameters, and unexpected parameters. The opt-in PostgreSQL fixture checks keyset pages, farm isolation, authorization under row locks, expiry after a lock wait, least-privilege grants, and unchanged enrollment status. It also signs in through the maintained authentication service, obtains its sealed host-only cookie, and carries that cookie over a task-owned loopback HTTP listener to the inventory request service and PostgreSQL. The listener is a test adapter, not the deployed Nuxt server.

The runner requires an explicitly identified disposable loopback PostgreSQL database named `fixture`, with the complete local migration catalog applied and its journal verified. It refuses a missing or modified journal. The caller owns database teardown and must set `INVENTORY_SYNTHETIC_TEST_DISPOSABLE=yes` and `INVENTORY_SYNTHETIC_TEST_PORT` to its isolated port. Run `bun scripts/test-postgres-connector-inventory.ts` only after provisioning that database and applying every migration in order. The fixture creates and removes its own login roles, closes its connections, and leaves synthetic rows for the caller's disposable database teardown.

This checkpoint does not establish hosted deployment, browser acceptance, physical device behavior, or the result of a PostgreSQL run. Record those results separately when the corresponding checks run.

A Chromium test with mocked inventory responses checks selection, status display, the disabled revocation action, and clearing after a 401 response. It does not establish database authorization or keyboard selection behavior.
