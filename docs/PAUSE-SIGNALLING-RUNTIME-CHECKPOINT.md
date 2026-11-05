# Pause signalling runtime composition

The existing signalling runtime now accepts a separate pause mode on
`/api/signalling/pause-browser` and `/api/signalling/pause-connector`, with the
exact subprotocol `open3dfarm.pause-signalling.v1`. The readonly paths and
subprotocol retain their original contract. A socket cannot change modes;
the corresponding strict decoder rejects the other mode's control messages.
WebSocket frames carry signalling metadata only, never commands or capability
payloads.

Both modes use one connection state machine and one shared resource owner.
There is one inbox per `(agentId, mode)`, at most two per agent, and sixteen
globally across both modes. This deliberate per-agent policy change permits
readonly status alongside a separate pause negotiation. Final admission
rechecks global capacity and mode uniqueness after all asynchronous proof work.
Original admission/lifetime, frame, byte and work limits remain unchanged.

Pause upgrades require the published pause-authority facade. Its origin,
credential issuer/audience and actual database endpoint identity must match
the signalling configuration. One pause coordinator belongs to each active
facade; it uses the existing current-authority reader and credential acceptor.
Facade abort closes its pause connections. Replacement cannot transfer an
existing connection or late awaited result to the new owner. Readonly service
remains available when pause is absent or incompatible.

Coordinator handles stay in mode-specific closures. Pause attach validates
transport, farm, agent and immutable assignment against the admitted context
before requesting a credential challenge. Returned context messages preserve
that tuple. Busy retries retain the original deadline and transport identity.
Neither a successful signalling proof nor a returned control binding grants
permission to dispatch a command.

Route callbacks retain the runtime that accepted the original Node upgrade
request. They do not fetch a replacement singleton for each message. A runtime
replacement while upgrade is awaiting session validation rejects that upgrade.
Unknown opens terminate instead of acquiring a new runtime.

## Validation boundary

Focused tests exercise both modes concurrently with actual cryptographic
proofs and sealed session cookies, but doubled database authority and sockets.
They cover duplicate inboxes, mixed-mode contention for the final global slot,
config/database mismatches, facade abort, late authority results, exact pause
scope, original expiry across retry, cross-mode/command rejection and route
owner replacement. Existing native WebSocket boundary tests continue to test
payload/control-frame rejection and upgrade handling using the pinned adapter.

Actual generated Nitro pause WSS, current PostgreSQL authority, separate
control RTC peers, issuer admission, durable dispatcher and isolated Moonraker
pause still require one integrated acceptance flow. The isolated native RTC
evidence in `PAUSE-CONTROL-RTC-CHECKPOINT.md` remains separate. No physical
printer, production service or new database grant is involved in this change.
