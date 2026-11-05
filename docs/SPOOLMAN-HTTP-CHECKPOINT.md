# Local Spoolman read checkpoint

`createLoopbackSpoolmanReader` now integrates HTTP GET, streaming bounds and the existing complete-inventory validator. It is an explicit local prototype, not connected to the application or a production mirror.

The trusted configuration accepts only canonical HTTP origins using literal 127.0.0.1 or [::1]. It snapshots scope and destination before use; callers can supply only cancellation. It never follows redirects or response links, resolves DNS, sends credentials, retries, or mutates service data. Local configuration remains trusted: this is not permission to query arbitrary host services.

The fixed `/api/v1/spool` request uses `limit`, `offset`, `sort=id:asc` and `allow_archived=true`, matching the [official Spoolman endpoint](https://github.com/Donkie/Spoolman/blob/master/spoolman/api/v1/spool.py). Synthetic tests assert these parameters; compatibility with the pinned running service now passed the [disposable API integration test](SPOOLMAN-ACTUAL-API-VALIDATION.md).

A single 1–60000 ms deadline includes every page, headers, streaming body and validation. Each decoded response is limited to 256 KiB, the traversal to 4 MiB, 256 pages and 10000 items. IDs must strictly increase across the entire traversal, as requested from the endpoint. HTTP errors, wrong content types, malformed UTF-8/JSON, duplicate or out-of-order IDs, cancellation and incomplete traversal reject the entire result with a fixed redacted error. No partial result escapes. The underlying runtime may allocate a received chunk before application limits can inspect it.

Eight Node tests use disposable synthetic loopback servers, including compressed oversized bodies, immutable destination, refused redirects, a hanging body and cancellation during headers. The cumulative deadline test rejects two individually timely pages that together exceed the overall budget.

The result is an observed traversal, not an atomic upstream snapshot: concurrent upstream changes can omit rows even with stable sorting and duplicate detection. No database, real accounts, authorization, remote endpoint configuration, TLS support, automatic polling or UI integration is included. Full simulator acceptance remains blocked by the independent Klipper serial issue. CI is unchanged; this work is local and unpublished.
