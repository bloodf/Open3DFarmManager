# Pause negotiation authority reader

`PostgresPauseNegotiation.read` reads fresh metadata for a separate pause control
peer. It returns no capability, signing key or command grant. The issuer and
Connector retain their independent current-authority, proof, safety and dispatch
checks.

The strict input contains the sealed-login owner's internal session record ID
and selected farm, Connector, browser key and immutable assignment UUIDs. Account
ID, role, key material, current credential JTI and opaque printer key come from
the database. Configuration supplies a pause origin/audience separately from the
credential issuer/audience. No request-provided time, URL or public key is
accepted. The scope and configuration are copied before asynchronous work.

The maintained session-expiry observer locks account SHARE then session UPDATE.
The reader subsequently takes membership SHARE, browser key SHARE, enrollment
SHARE, credential UPDATE, optional credential proof slot SHARE and assignment
SHARE. Enrollment locking serializes assignment/revocation changes; credential
UPDATE serializes creation of an initially absent proof slot against the
maintained acceptor's credential SHARE. Membership must be current owner, admin
or operator; viewers are denied. The approved key must belong to the current
account and farm. Enrollment, credential, revocation records, terminal proof
markers and the exact assignment are checked independently.

Persisted P-256 and Ed25519 public material is validated with maintained native
cryptographic helpers. Thumbprints and fingerprints must match their stored
counterparts. A final database observation occurs after locks and cryptographic
work, including ordinary denied paths that may have waited. Null terminal
observations and clock regression deny normally and commit observed session
expiry. The reader does not touch session activity or mutate issuance budgets,
proof slots or assignments. Storage failures fail closed.

After COMMIT, the maintained pure signalling budget helper deducts the complete
transaction round trip using local monotonic time and rejects discontinuity,
unacceptable DB/host skew and exhausted authority. No caller clock injection is
provided. The returned metadata is frozen. It is a point-in-time observation,
not a guarantee that authorization remains unchanged after COMMIT. Future
negotiation must cap its original eight-second admission/thirty-second lifetime
and revalidate without extending deadlines. Revalidation must compare the pinned
identity, credential and assignment metadata; a changed snapshot requires a new
context rather than replacing fields inside an existing binding.

Migration 0018 already grants the required SELECT, row-lock UPDATE-column and
session-observer EXECUTE permissions to `farm_pause_authority`. No new migration
or grant is included. That role is mutation-capable; the reader's limited API must
not be described as a database read-only role.

The focused tests use a deliberate SQL boundary double with native key
validation. They cover query scope/order, denied roles and inactive/mismatched
records, absent/terminal proof slots, late expiry, copied input and post-COMMIT
budget. They do not prove actual PostgreSQL privileges, contention or rollback
behavior. Real PG role/race acceptance, server negotiation routing, actual new
control peers and full repository checks remain separate required gates.
