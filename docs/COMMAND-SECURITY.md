# Command authorization prototype

This branch implements a library boundary, not a printer-control feature. No driver or WebRTC transport invokes it yet. The authenticated Connector context and key distribution remain unimplemented.

The browser generates a nonextractable ECDSA P-256 key with WebCrypto. Each signature covers canonical JSON, including farm, Connector, printer, user, key and session IDs, action, timestamps, random command ID and a 128-bit nonce. The Connector verifies the P1363 signature with Node crypto. Wire JSON must be canonical: duplicate fields, padding and alternate representations are rejected. Frames are limited to 8 KiB. Only pause, resume, cancel and emergency stop are represented; arbitrary G-code is excluded.

The authorization context must come from an authenticated local session and authenticated authorization data, never from fields supplied by the command sender. Membership and key roles are checked independently from the signature. The prototype requires an authorization lease of at most 60 seconds and fails closed when it expires. This provisional choice bounds stale authorization, but prevents commands during a longer control-plane outage. The product's offline policy and authenticated lease distribution still need a decision and integration tests. Offline remote revocation cannot be instantaneous.

Replay claims use a local SQLite transaction before authorization is returned. Command ID and key/nonce uniqueness survive restart. A ten-minute retention window exceeds the one-minute command validity; capacity exhaustion and backwards clock movement fail closed. Accepted commands are limited to ten per minute per printer; emergency stop bypasses that rate cap but still requires identity, signature, freshness and a successful replay claim. Storage exhaustion can therefore reject an emergency stop too: software remote control does not replace a physical emergency stop.

The state directory must be owned by the current OS user and inaccessible to other users. Symlink database paths and shared files are rejected. This protects against accidental unsafe placement, not a hostile process running as the same OS user. No automatic replay or retry may follow an uncertain physical result. Future dispatch must consume the claim once, record its result and expose uncertainty explicitly.

Nonextractability prevents exporting the private key through WebCrypto; it does not stop compromised same-origin JavaScript from asking the browser to sign. Browser origin isolation, CSP, authenticated Connector identity, session binding and key revocation integration remain necessary. Browser read-only HTTP fallback must never carry printer commands. Bed-clear interlocks, driver state checks and audit persistence are not supplied by this library.

Validation includes canonicalization edge cases, signature tampering, scope substitution, expired authorization, revoked keys, storage failures, persistent replay across connections/restarts, capacity and rate checks, and a real Chromium-to-Node signature test. No test contacts a physical printer or starts a container.

## Runtime rejection boundary

The integrated verifier validates the runtime structure of the supplied authorization context before accessing its fields. Missing or malformed context returns `invalid-context` without invoking replay storage. This shape check does not authenticate the context or change its provenance requirements. Existing scope, role, signature, freshness and replay decisions remain required.

Storage results are restricted to the declared result set. An unexpected adapter result is mapped to `storage-unavailable`, never returned as an arbitrary protocol reason. Each valid request makes at most one claim attempt; no retry is introduced. Rejection reasons now have a closed TypeScript union. Tests reproduce missing-context exceptions and leaked adapter result strings before these fixes, then assert fixed denials and zero replay calls for malformed input.

## Command authorization rule

Browser commands stay WebRTC-only with no TURN or HTTP fallback; API-originated commands are allowed only with an owner-granted scope, delivered as issuer-signed envelopes, and enforced by the Connector, which refuses unsafe or unauthorized commands with a reason. No automatic retry of uncertain commands, and never command physical printers in automated tests.

## Connector checks for API commands

API-originated commands travel via the integration API (`/api/integrations/v1`) and are delivered to the Connector as issuer-signed envelopes. The Connector enforces local safety and authorization independently before dispatching any command to a printer driver. An offline or isolated Connector fails closed on expired or unverified authority.

When receiving an API-originated command envelope, the Connector executes the following checks in order and refuses any failing command with an explicit reason code:

1. **Envelope framing and canonical shape (`invalid-command`, `invalid-envelope`):**
   - Validates that the wire payload is canonical JSON within bounded frame limits (maximum 8 KiB).
   - Rejects duplicate keys, unescaped control characters, non-canonical encodings, or invalid UTF-8 sequences.
   - Verifies the presence and types of all required envelope fields: schema version, issuer identifier, farm ID, agent ID, printer ID, client/app ID, command ID, action, arguments, `issued_at`, `expires_at`, and nonce.

2. **Issuer signature verification (`invalid-signature`, `invalid-issuer`):**
   - Resolves the issuer public key from local trusted configuration (the farm's trusted issuer keyring), never from sender-provided headers or unverified payloads.
   - Verifies the cryptographic signature (ECDSA P-256 with SHA-256, IEEE P1363 encoding) over the canonical unsigned envelope bytes.
   - Refuses commands with invalid signatures, unresolvable keys, or untrusted issuers.

3. **Farm and Connector agent scope binding (`scope-mismatch`):**
   - Verifies that `farm_id` in the envelope matches the Connector's locally enrolled farm.
   - Verifies that `agent_id` matches the Connector's own authenticated agent identity.
   - Refuses commands targeted at other farms or other Connectors.

4. **Printer assignment binding (`unknown-printer`):**
   - Verifies that `printer_id` matches an active printer currently assigned and locally bound to this Connector.
   - Refuses commands targeted at unknown, unassigned, or foreign printer IDs.

5. **Owner-granted scope authorization (`unauthorized`, `scope-denied`):**
   - Verifies that the envelope carries an owner-granted scope authorizing the specific action (e.g. `printers:control` for pause/resume/cancel/stop, `jobs:write` for starting/cancelling jobs).
   - Refuses commands if the required scope was not granted by the farm owner for the calling application.

6. **Freshness and clock validation (`invalid-clock`, `command-expired`, `clock-window`):**
   - Validates monotonic time against system wall clock; detects and fails closed on backwards clock regression.
   - Verifies that `issued_at` falls within the allowed clock skew window (at most 60 seconds from current Connector reference time).
   - Verifies that `expires_at > now`; fails closed if the command envelope has expired.

7. **Durable replay protection (`replay`, `storage-unavailable`):**
   - Atomically records the unique `command_id` and `nonce` in the local SQLite replay database within a transaction prior to execution.
   - Refuses any previously observed `command_id` or reused `nonce` within the retention window.
   - Fails closed with `storage-unavailable` if disk capacity is exhausted or replay storage cannot commit.

8. **Rate limiting (`rate-limited`):**
   - Enforces per-printer and per-application rate caps (default maximum 10 commands per minute per printer).
   - Emergency stop bypasses the operational rate limit but still strictly enforces issuer signature, identity, freshness, and replay claim.

9. **Printer state and driver safety interlocks (`unsafe-state`):**
   - Checks the target printer's current local state before execution.
   - Refuses actions that violate physical safety invariants (e.g. starting a print when bed is not clear or printer is in an error/fault state; extruding below minimum extrusion temperature; cancelling or pausing a printer that is not active).
   - Refuses unsafe commands with a specific diagnostic reason.

10. **Single consumption and uncertainty policy:**
    - Consumes the replay claim exactly once; no automatic retry of uncertain commands.
    - If the physical dispatch result or connection to the printer driver fails or is ambiguous, the Connector records and reports uncertainty explicitly rather than retrying.
