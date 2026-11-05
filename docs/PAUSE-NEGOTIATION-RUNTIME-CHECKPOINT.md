# Pause negotiation runtime publication

The internal `currentPauseNegotiationRuntime()` accessor publishes a frozen
negotiation facade atomically with the HTTP issuer service. Both use the same
role-validated issuer pool, still limited to four connections. Startup obtains
actual database name, server address and server port from that pool; URL text is
not substituted for database identity. Unix-socket address/port may be null.
The signalling integration must compare that identity and configured origin and
credential issuer/audience with its own runtime before accepting pause sockets.

The facade contains an opaque owner, terminal AbortSignal, origin, pause audience,
separate credential issuer/audience, database identity and a frozen `read` method.
It exposes neither the pool nor issuer keys. The maintained pause negotiation
reader supplies current authority; the facade is not a capability grant. The
underlying `farm_pause_authority` database role remains mutation-capable. No new
role, grant or connection pool is introduced.

Closing unpublishes both interfaces and aborts borrowers synchronously before
ending the pool. Reentrant close returns the same completion promise. Pending
startup retains ownership until settlement and cannot publish after close.
Retained readers deny new calls after closure and discard results that settle
under a stale owner. Pool cleanup failure leaves startup ownership reserved;
there is no automatic replacement that could hide an unresolved pool.

Five new Node lifecycle tests use explicit module-boundary doubles for issuer
key loading, role validation, pool, service and reader. Six existing issuer-runtime
tests also pass, including actual private-key-file validation. They do not prove
PostgreSQL identity queries, role privileges, shared-pool contention or genuine
signalling integration. No WSS, browser, native peer or command execution ran.
Runtime coupling requires an active configured issuer but creates no plugin wait
cycle: consumers synchronously inspect publication and fail closed if absent.
