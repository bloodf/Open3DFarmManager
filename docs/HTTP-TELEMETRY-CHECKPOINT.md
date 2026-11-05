# Bounded HTTP telemetry checkpoint

The existing one-attempt drain now has a native-fetch adapter in `packages/connector/src/cloud/http-telemetry.ts`. It validates an outbound printer-state batch before sending and maps the internal ingestion result `{ ok: true, acceptedEventIds }` to the exact-ID confirmation expected by the drain. This is a prototype HTTP mapping; no application ingestion route, credential provider or scheduled Connector loop is installed.

The configured endpoint requires HTTPS by default, rejects URL credentials/query/fragment and disables redirects. Tests explicitly opt into HTTP only for loopback IP literals. That option must not be enabled in a production transport configuration. The adapter sends no credentials and does not authenticate an agent. The loopback test server is a test fixture, not an exposed Nuxt endpoint.

The caller's cancellation signal is combined with an explicit 1–60,000 ms request deadline. The deadline covers fetch headers and streaming body reads. Cleanup clears the timer and aborts the native request. Success requires status 200, JSON content type, at most 8 KiB of response bytes, valid UTF-8 and bounded unambiguous JSON with only the expected acceptance fields. The existing drain still checks exact event-ID correspondence before deleting queue records. The adapter never retries automatically and rejects command-shaped outbound payloads.

## Actual local transport verification

Six Node tests use a real HTTP server bound to an ephemeral port on 127.0.0.1:

- Disk-backed queue → native POST → internal ingestion with synthetic trusted context/test store → acknowledgement → empty queue.
- Deadline expiry during stalled headers and during a stalled response body; the server observes response closure.
- Caller abort during response streaming; queue records remain until a later explicit attempt, and the native request settles so the queue's concurrency slot becomes available.
- Oversized responses, invalid UTF-8, duplicate JSON keys, wrong MIME/status and redirects are rejected. Redirects do not produce a second request.
- Disallowed endpoint configuration and invalid outbound command-shaped data do not send requests.
- A maximum batch of 100 accepted event IDs fits the response bounds.

`check:all` passed with 148 Bun and 75 Node tests, lint, typecheck and builds. Browser code was unchanged and the nine existing Chromium tests were not repeated.

## Limits

Cancellation cannot prove that the server did not commit before the response was lost. Stable event IDs and durable server deduplication remain required; no exactly-once network claim is made. This adapter is for telemetry only and provides no command path or physical-action retry.

The real authenticated endpoint, credential lifecycle, TLS/deployment verification, durable database adapter, rate limits and scheduler remain unimplemented. The loopback fixture's enrollment context and in-memory destination are synthetic. HTTPS certificate behavior and real network failures outside loopback were not tested here. There is no plaintext fallback in the normal configuration.
