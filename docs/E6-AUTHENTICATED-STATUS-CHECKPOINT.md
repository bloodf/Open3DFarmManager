# E6 authenticated status checkpoint

This slice prepares an injected, read-only farm status feed. The feed implementation and callback correction are `deaf602` and `28047e8`; genuine-status transport is `0c0e96f` and the final source checkpoint is `2a291340d86068057de8ddf6560f13ceec7be0cc`. After these changes, the eight-file focused suite passed 52 of 52 tests under Node 24.20.0 in 632.756167 ms and 52 of 52 under Bun 1.4.2 in 795 ms, including nine feed cases. Focused strict TypeScript and formatting checks passed. These tests use mock transport and real cryptography; they do not establish production authorization or actual network, native, Chromium or PostgreSQL behavior.

## Feed contract

`createAuthenticatedFarmStatusFeed` receives a key resolver and optional client factory. The resolver must return an existing local browser device key scoped to the exact account, farm and view epoch. The feed snapshots its input before awaiting and rechecks the returned scope and key. It does not create or enroll keys. A current registry lookup can narrow the local key selection; it cannot replace server admission.

The feed arms its original eight-second authentication and thirty-second lifetime limits before key resolution. It publishes authenticated health only after the RTC endpoint reports the validated binding and mutual proof verification. It copies and validates the binding and local session metadata before callbacks. A new open for the same account, farm and Connector retires the old generation, including pending key resolution. Abort, expiry, partial or oversized status, changed assignment mapping and unavailable source must close the active generation rather than publish stale data.

The intended Connector provider supplies complete status for the exact current assignment tuples and their `PrinterState` values. It must validate monotonic capture and validity evidence locally, require `capturedMono <= now < validUntil <= admittedDeadline`, arm an independent expiry timer, and terminate the sender session on mapping changes or unavailable data. The sender aborts its provider subscription on WebSocket or RTC closure, and closes its snapshotted provider handle. Source expiry, mapping changes and unavailable data are terminal. These provider-side checks do not add fields to the existing RTC status wire format.

## Wire and authority limits

The existing `StatusMessage` remains a complete snapshot with a strictly increasing sequence, limited to 2,048 UTF-8 bytes. The feed verifies the complete, unique local printer-key set and marks `sourceClockComparable: false`. It emits copied, immutable session metadata and snapshots; this metadata is evidence of an admitted RTC session, not independent authority.

`StatusMessage` contains printer keys, not assignment IDs or source freshness evidence. `RtcSessionBinding` also contains no assignment IDs. Exact assignment tuples are checked by the trusted Connector provider and local inventory, but are not cryptographically bound into these messages. This residual ambiguity requires the current assignment authority and provider composition to be supplied and reviewed. The feed is display-only and must never establish command eligibility.

## Integration still required

The actual scoped key resolver and complete current-0015 assignment provider are not composed in this slice. The shared wire schema is unchanged. No Connector CLI, runtime, collector, farm view or composable is wired to this feed, and no production default is provided. Actual WebSocket/PostgreSQL authority integration and the current-head comprehensive checks remain separate gates.

## Independent review corrections

The feed projects exactly the three assignment fields from inventory rows. Connector admission subscribers installed reentrantly receive the stored admission once. The sender checks the incoming source deadline again after validation. The RTC session reserves sequence and message budget before calling the transport and refuses nested sends.

A genuine-status browser session may retain one bounded raw application frame while its local proof verification is pending. It exposes no status before verification, closes on a second pending frame, and discards the retained frame on termination. The existing authentication deadline still applies. This handles asymmetric proof completion without claiming the other endpoint is already verified or changing the wire protocol.

The four focused Node suites passed 34 tests, including real role proofs with delayed browser admission, overflow/closure discard, reentrant admission and send callbacks, full inventory records, and expiry during validation. Scoped strict TypeScript passed. These checks do not establish actual current-head native RTC, HTTPS/PostgreSQL integration, or full `check:all` acceptance.

A follow-up review found reentrant verification callbacks could overtake the retained frame. Application delivery now drains a FIFO after verification notification. Before verification the cap remains one 2 KiB frame; after verification the cap is two frames including the active callback, at most 4 KiB. Reentrant receipt queues behind earlier frames, and overflow closes and discards queued data. The focused Node suites now pass 35 tests, including verification and consumer callback ordering.
