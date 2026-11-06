# Bounded HTTP telemetry checkpoint

The one-attempt drain has two HTTP adapters. `createTelemetryHttpSender` in `packages/connector/src/cloud/http-telemetry.ts` validates an outbound printer-state batch before sending and maps the internal ingestion result `{ ok: true, acceptedEventIds }` to the exact-ID confirmation expected by the drain. It is a prototype mapping, and `tests/node/http-telemetry.test.ts:9` is the only module that imports it. The maintained sender is `createAuthenticatedTelemetrySender` in `packages/connector/src/cloud/authenticated-http-telemetry.ts`, and `packages/connector/src/runtime/agent.ts:73` imports it for the Connector runtime.

Both adapters require HTTPS by default and accept plain HTTP only for loopback IP literals when a test opts in explicitly. The prototype rejects URL credentials, a query string and a fragment. The maintained sender requires the endpoint to be exactly the origin plus `/api/connector/telemetry`, which excludes the same three parts. Both send `redirect: 'error'` and `credentials: 'omit'`. The loopback option must not be enabled in a production transport configuration. The prototype sends no credentials and does not authenticate an agent. The loopback test server is a test fixture, not an exposed Nuxt endpoint.

Both adapters combine the caller's cancellation signal with an explicit 1 to 60,000 ms request deadline, and the deadline covers fetch headers and streaming body reads. Cleanup clears the timer and aborts the native request. Success requires status 200, a JSON content type, at most 8 KiB of response bytes, valid UTF-8 and bounded unambiguous JSON. The prototype accepts only the expected acceptance fields, and the maintained sender also accepts status 429, because a busy proof service answers 429 with a bounded retry interval. The existing drain still checks exact event-ID correspondence before deleting queue records. The prototype never retries automatically and rejects command-shaped outbound payloads. The maintained sender retries only a busy answer, at most 8 times, and stays inside the request deadline and the proof lifetime.

## Actual local transport verification

The evidence in this section belongs to the 2026-11-04 slice. The counts and results describe that commit, not the current tree.

Six Node tests use a real HTTP server bound to an ephemeral port on 127.0.0.1:

- Disk-backed queue → native POST → internal ingestion with synthetic trusted context/test store → acknowledgement → empty queue.
- Deadline expiry during stalled headers and during a stalled response body; the server observes response closure.
- Caller abort during response streaming; queue records remain until a later explicit attempt, and the native request settles so the queue's concurrency slot becomes available.
- Oversized responses, invalid UTF-8, duplicate JSON keys, wrong MIME/status and redirects are rejected. Redirects do not produce a second request.
- Disallowed endpoint configuration and invalid outbound command-shaped data do not send requests.
- A maximum batch of 100 accepted event IDs fits the response bounds.

`check:all` passed for that slice with 148 Bun and 75 Node tests, lint, typecheck and builds. Browser code was unchanged and the nine existing Chromium tests were not repeated.

## Current state

An application ingestion route, a credential provider and a Connector drain loop exist today.

The routes are `apps/farm/server/api/connector/telemetry.post.ts` and `apps/farm/server/api/connector/telemetry/challenge.post.ts`. Each rejects a request that fails the boundary inspection with 400, and each answers 503 while `telemetryHttpRuntime()` returns no handler. `apps/farm/server/plugins/telemetry-lifecycle.ts` starts the runtime from the `connectorTelemetry` Nuxt runtime configuration, and `apps/farm/nuxt.config.ts` ships `enabled: false`, so the handler stays uninstalled until an operator supplies the full configuration.

The credential provider is `PostgresConnectorCredentialAcceptance` in `apps/farm/server/storage/postgres-connector-credential-acceptance.ts`. The handler in `apps/farm/server/services/telemetry-http.ts:24` checks the bearer token and the farm and agent headers, then asks the provider to issue a proof challenge on the challenge route and to commit the batch on the final route. The provider checks the printer assignment rows and the proof lifetime before it writes.

The drain loop is the Connector runtime's own serial loop, `drainLoop` in `packages/connector/src/runtime/agent.ts:199`, which calls `drainTelemetryOnce` at `packages/connector/src/runtime/agent.ts:238`. It runs inside the Connector process and is not a deployment-level scheduler.

## Limits

Cancellation cannot prove that the server did not commit before the response was lost. Stable event IDs and durable server deduplication remain required; no exactly-once network claim is made. Both adapters are for telemetry only and provide no command path or physical-action retry.

Deployment TLS verification and an external scheduler remain absent, as do event retention and storage quotas. The loopback fixture's enrollment context and in-memory destination are synthetic. Certificate behavior and real network failures outside loopback were not covered by the tests recorded above, and the prototype's loopback option must not reach a production transport configuration. There is no plaintext fallback in the normal configuration.
