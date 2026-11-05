# Fixed Moonraker pause driver checkpoint

This original MIT library adds one genuine-binding-owned, one-shot local WebSocket pause driver. It is not wired into the Connector CLI, runtime, browser, RTC adapter or server issuer. Calling this trusted local library does not establish command authority. The existing dispatcher, verifier, journal, telemetry collector and read-only RTC modules are unchanged.

## Primary-source contract and licensing

The contract is pinned to official Moonraker v0.9.3 commit `71f9e677b81afcc6b99dd5002f595025c38edc7b`, resolved from its annotated release tag. Its [API specification](https://github.com/Arksine/moonraker/blob/71f9e677b81afcc6b99dd5002f595025c38edc7b/docs/web_api.md#pause-a-print) defines the fixed JSON-RPC pause method with no arguments and a successful string result `ok`. The [query specification](https://github.com/Arksine/moonraker/blob/71f9e677b81afcc6b99dd5002f595025c38edc7b/docs/web_api.md#query-printer-object-status) defines object-field selection and the `eventtime`/`status` result. The [implementation](https://github.com/Arksine/moonraker/blob/71f9e677b81afcc6b99dd5002f595025c38edc7b/moonraker/components/klippy_apis.py) registers the pause endpoint and forwards the fixed Klipper pause operation.

Moonraker is GPLv3. Its source and license were consulted and retained outside this repository as reference evidence; no implementation was copied, bundled or added as a dependency. This driver uses the already approved MIT `ws` 8.22.1 dependency and existing Zod/protocol helpers without package or notice changes.

This source pin does **not** establish correspondence with the configured simulator image digest `c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47`. Its outer virtual-printer revision clones Moonraker without a fixed revision argument. Exact image/source correspondence and simulator pause acceptance remain separate unvalidated gates.

## Local endpoint and lifetime ownership

`openFixedMoonrakerPause` accepts one genuine `PrinterBinding`, local origin allowlist, existing Moonraker limits, trusted connection generation, monotonic clock, synchronous observation publisher and permanent owner AbortSignal. It derives the fixed `/websocket` endpoint from the immutable live local mapping. A command cannot provide a URL, method, script, arguments, replacement binding or reconnect target.

`prepare()` opens that one connection and takes one complete query. The driver can attempt pause once; a false or throwing guard consumes the connection without a pause send. A second attempt cannot resend. The native socket must be open, have no pending request and have zero buffered outbound bytes before a request is prepared. Pause bytes and the bounded reply slot exist before `beforeSend`. After a true result, the driver invokes native `send` on that synchronous stack with no await, additional clock sample or publication in between.

The connection has an original 30-second maximum lifetime and an eight-second maximum preparation window. Lower configured connection/request limits still apply. A pause attempt starts a nonrenewable five-second local operation deadline; the dispatcher’s earlier original result deadline and cancellation remain authoritative and may shorten it. Each reply timeout is capped at 500 ms and the remaining operation budget. There are no recurring background polls or reconnection timers.

Receiver limits are at most 4,096 bytes per message, 32 fragments, 32 buffered chunks, 16 received messages and 32 KiB cumulative payload. UTF-8 and bounded JSON validation precede strict reply validation. Compression, redirects, optional native addons and automatic pong output are disabled; native ping or unsolicited pong terminates the connection. Unexpected IDs, notifications, duplicate properties, remote errors and malformed or excessive input terminate rather than create fresh observations.

## Complete observations and uncertainty

Only complete query replies containing both selected state fields produce observations. Each field’s conservative observation time is the local query-request start; local receipt time is recorded separately. Source eventtime must strictly advance on the same connection. A progress-only notification cannot refresh readiness or printing state. Generation and sequence are locally owned metadata, never extracted from a command.

After the exact pause acknowledgement, `waitForPaused` makes at most eight further complete queries. It requires the same binding, signal and generation, a newer sequence, readiness, paused state and both query-start field times strictly after the send cursor. Equal or regressing source times fail closed. Exhaustion, cancellation, expiry, socket failure or uncertain replies publish `null`, reject pending work and terminate the socket. The `closed` promise joins the actual native close event. There is no automatic reconciliation or pause retry.

The dispatcher deliberately aborts per-command work before its final pure result audit. After a fresh paused result is copied and published, the driver detaches only that per-command cancellation listener. The permanent owner signal, native socket liveness and original bounded timers remain active through audit. Permanent abort or socket loss still immediately publishes `null`. The future runtime owner must close this driver after dispatch settles; it must also terminate the opaque peer lifecycle on context loss. The driver never extends capability or transport authority.

## Focused evidence and remaining integration

`node --test tests/node/moonraker-pause-driver.test.ts` passed eleven groups against an actual Node `ws` client and an independently owned loopback fake Moonraker server. Focused strict TypeScript and changed-file formatting/diff checks passed. Tests cover the exact fixed request/ack/query flow, copied request-start freshness, one-shot guard rejection, malformed/binary/duplicate/oversized/fragmented input, unsolicited progress, native ping without pong, lost acknowledgement without retry, stale source time, bounded post-send queries, pending-query cancellation, lifecycle expiry/regression, binding mismatch and the two-signal audit lifetime.

No real Moonraker, simulator or physical printer command was sent. No PostgreSQL, container, dependency installation, build, browser or native RTC run was performed for this slice. Test servers and sockets were closed; bounded source/license/check logs remain outside the repository. Repository-wide checks are coordinated separately and are not claimed here.

The next integration must retain genuine local mapping handles in the runtime, connect current server-issued pause authority to a dedicated authenticated direct control RTC peer, provide the narrow identity signer and publish lifecycle revocation into the dispatcher. Existing read-only transport remains command-disabled. The E6 complete-display-snapshot seam is separate and must not use deduplicated telemetry receipt times as command eligibility. Exact simulator source matching, one instrumented simulator pause, outage/expiry/uncertainty behavior and a full current-head gate remain pending. No backend command relay, HTTP fallback, TURN or production command path is introduced.
