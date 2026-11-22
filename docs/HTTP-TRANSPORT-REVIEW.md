# Local HTTP transport security review

Reviewed the endpoint/configuration boundary, native fetch invocation, redirect policy, response reader and acknowledgement parser in `packages/connector/src/cloud/http-telemetry.ts`. All verification uses synthetic values and loopback HTTP servers. No production host, real device or DNS configuration was contacted or changed.

## Reproduced and corrected

The constructor called `new URL` outside its sanitizing error boundary. Invalid URL errors escaped directly; native URL errors can carry the configured input, and property-access errors could propagate their original message. A regression test reproduced the unsanitized error. Configuration parsing now returns one fixed error without forwarding cause/input properties. Operational transport errors remain fixed and do not include the response body or underlying fetch error.

URL parsing also silently normalized controls, whitespace and backslashes. A regression test showed an embedded newline was accepted. Configuration now rejects those characters before parsing and caps the endpoint string at 2,048 characters. This removes ambiguous configuration; it is not a complete SSRF defense.

## Destination and DNS boundary

The endpoint is snapshotted at construction. A test mutates the original options object and confirms requests still reach only the original server. Redirects are disabled; a 307 to a second loopback origin is rejected without contacting that origin. Outbound telemetry data cannot select a destination. The HTTP test exception permits only loopback IP addresses after URL parsing, with no hostname resolution for that exception.

Normal HTTPS configuration still permits operator-chosen hosts, including private addresses and hostnames resolving to private networks. There is no IP allowlist, DNS-address pinning or rebinding defense in this adapter. HTTPS and redirect rejection alone do not establish SSRF protection. No endpoint should be accepted from an unauthenticated request, discovery result, printer metadata or other untrusted input. The configuration must remain trusted and reviewed before production wiring.

No live DNS rebinding experiment was performed. Deployment policy must decide whether private/self-hosted destinations are supported and how to constrain resolved addresses; silently forbidding private networks here would make that unresolved product/deployment decision. If untrusted destination selection is ever introduced, this transport is not an adequate security boundary for it.

## Response-bound verification

Local tests now cover an open-ended chunked response exceeding 8 KiB and a small gzip response expanding beyond 8 KiB. Both are rejected, confirming that the application checks delivered/decompressed bytes rather than relying only on Content-Length. The open response is closed on failure. Error assertions confirm the synthetic private response marker is not exposed.

The 8 KiB limit bounds accumulated application payload, not every allocation inside the native HTTP/decompression stack. Deadlines bound waiting; they do not constitute a CPU or process-memory isolation guarantee. Existing tests also cover malformed UTF-8/duplicate JSON, wrong status/MIME, invalid outbound commands, exact maximum ID count and actual cancellation of stalled headers/body.

## Scope and remaining gaps

No credentials are sent, no authenticated endpoint exists, and no production route or scheduler uses this adapter. TLS identity behavior and resolver/network policies outside loopback remain unverified. Future credential support must preserve destination trust, prevent forwarding on redirects and redact errors/logs. Server-side rate limiting, persistent deduplication and real enrollment authorization remain separate prerequisites.

Validation: `check:all` passed with 148 Bun and 79 Node tests, lint, typecheck and builds. The nine existing Chromium tests were unchanged and not rerun for this review.

## Untrusted data integration checkpoint

Three further Node tests connect the existing queue, real loopback HTTP sender and ingestion service with a synthetic trusted printer scope/test store:

- Extra endpoint, URL, destination, redirect, headers and `__proto__` fields at either event or printer-state level are rejected before any request. Neither the configured server nor the second destination receives traffic.
- A URL-shaped printer identifier is treated only as data. The destination returns a deliberately invalid acknowledgement with an extra endpoint field, so the queue retains the event even though the synthetic store has accepted it. A second explicit delivery uses the original captured destination, despite mutation of the original configuration object, and deduplicates successfully. A Location header on the successful 200 response is not followed.
- Redirect responses 301, 302, 303, 307 and 308 all preserve the same queued event and never contact the second origin.

These tests prove the destination-selection properties of this component flow. There is still no public request handler, production credential flow or durable server database. They do not establish safe acceptance of arbitrary configuration URLs, DNS rebinding protection, or production SSRF resistance. No new application abstraction or destination configuration input was added for this checkpoint.

Latest destination-boundary validation: lint, typecheck and all 82 Node tests passed. This test/documentation-only change did not rerun the previously passing 148 Bun tests, builds or nine Chromium tests.
