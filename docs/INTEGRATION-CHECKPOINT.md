# Local Phase 0 integration checkpoint

Integrated on 2026-11-04 in `farm/phase-0-integration`, based on PR #1 head `2054676dd3e21075d4fe80d6efa3137343d42f70`. This is a local integration checkpoint, not a release, deployment or completed Phase 0 acceptance. The source branches remain intact.

| Source branch           | Integrated head |
| ----------------------- | --------------- |
| farm/bounded-json       | 892236a         |
| farm/connector-identity | 970b5a5         |
| farm/pairing-contracts  | 8eeaa33         |
| farm/command-security   | 30078eb         |
| farm/telemetry-queue    | 0b10b08         |
| farm/reconnect-policy   | b70f388         |
| farm/moonraker-parser   | 4ad4383         |
| farm/spoolman-contracts | d997f5c         |
| farm/simulator-harness  | a7f45e2         |

## Integration changes

Two additive merge conflicts occurred in the protocol export file, resolved by retaining JSON, pairing, canonicalization, encoding and signing exports. A script conflict in `package.json` retained the simulator seed/verification commands and the Node test suite. No workflow file changed relative to the PR head.

The bounded JSON reader is now used by command decoding, pairing poll responses, Moonraker parsing and Spoolman parsing as well as signalling. Tests require duplicate fields to fail at those boundaries. Some nonfinite values and oversized strings now fail before domain validation; their tests assert the precise earlier error code instead of weakening rejection.

A Node component test uses a temporary private directory to combine Ed25519 identity, the pairing fingerprint contract, synthetic Moonraker telemetry, the durable queue and persistent P-256 command replay claims. It verifies identity preservation, telemetry recovery after close/reopen, rejection of a command as telemetry, replay rejection after reopen and FIFO acknowledgement. Its authorization context is a test fixture, not an authenticated server session.

## Verification

- Offline frozen-lockfile installation passed without dependency downloads or lifecycle scripts.
- Combined formatting, TypeScript/Nuxt type checks and production builds passed.
- 122 Bun tests passed, including the JSON differential cases.
- 29 Node runtime tests passed, including storage concurrency and combined component coverage.
- Two Chromium tests passed: the hidden farm route and browser-generated signature verified once by Node.
- Three existing CLI cases also passed against the built executable.
- Compose configuration parsing and Git whitespace checks passed.
- Workflow files are unchanged from the base PR head.

Local HTTP tests use synthetic loopback servers; no physical printer or external Spoolman/Moonraker instance was contacted. Compose parsing did not build or run an image. Container integration, image execution and network-fault scenarios have not been validated.

## Review limits and remaining acceptance

The signed-command verifier still requires externally authenticated identities, roles, scope and authorization freshness. Its sixty-second authorization lease remains an explicitly provisional prototype setting; the product's offline revocation policy is unresolved. Emergency stop bypasses only the rate cap, not signature, freshness, replay or storage checks. No physical command dispatcher is wired to the verifier.

The telemetry queue and identity store retain their fail-closed recovery limits after interrupted initialization or a stale lock. Atomic file publication, replay transactions and shared-directory coexistence are covered by local tests, not power-loss fault injection or an independent security audit. Filesystem guarantees assume trusted ancestors and no hostile process sharing the OS account.

Database migrations, independent login, authenticated pairing endpoints, credential issuance/rotation, key distribution, WebRTC transport, live Moonraker subscriptions, Spoolman reconciliation, simulator container acceptance and the working farm interface remain incomplete. Read-only schemas and deterministic tests do not establish production authentication, device safety or end-to-end functionality.
