# Spoolman per farm

Owners and administrators configure one Spoolman for the farm in the pt-BR
**Spoolman** page. This is not part of the bearer-token integration API
(`docs/api/openapi-v1.yaml`); these routes are session-authenticated, like the
other farm management pages.

## Flow

1. The browser opens an authenticated `config-v1` RTC session to each approved
   Connector, using the same owner-issued authority evidence as printer
   provisioning (prepare, commit, revision, cancel).
2. `prepare` carries the `spoolman` target: origin plus optional credentials
   (`token`, or `username` and `password`). The Connector runs the connection
   test and answers a signed prepared receipt, or an error: `spoolman-unreachable`
   or `spoolman-unauthorized`.
3. `commit` writes `collection.spoolman` into the Connector runtime
   configuration and the credentials into a private file (`credentials/spoolman.json`,
   mode 0600). The server never receives them. Replacing the setting rotates the
   file and keeps the `serviceId`.
4. The browser reports the non-secret outcome to the server.

Connectors that already have a local Spoolman configuration keep working: the
`credentialFile` field is optional, and a credential bound to another origin is
never sent.

A farm setting is not printer inventory: no inventory acknowledgement is asked
for and it never appears in pending inventory confirmations. A Connector needs
an existing runtime configuration with at least one printer before it can accept
the setting; otherwise `commit` answers `not-available`.

## Server routes

`GET /api/farms/{farmId}/spoolman` lists `{ agentId, origin, status,
configured, checkedAt }` per Connector and `canManage`. `PUT` (owner or
administrator, exact `Origin`, JSON, 4 KiB) stores one such row. The body is a
strict object: any other field, notably a credential, is `400`. A failed test
never replaces a setting that is already applied (`configured: true`).

Database: migration `0052_spoolman_farm_settings`, role `farm_spoolman_settings`
(set `NUXT_SPOOLMAN_SETTINGS_ENABLED=true` and
`NUXT_SPOOLMAN_SETTINGS_DATABASE_URL`).
