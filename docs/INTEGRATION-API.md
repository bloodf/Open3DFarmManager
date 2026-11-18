# Integration API

The OpenFarm integration API lets third-party applications observe and control
a farm under scopes an owner grants. The contract is
[`docs/api/openapi-v1.yaml`](api/openapi-v1.yaml); each server publishes it
unchanged, as JSON, at `GET /api/integrations/v1/openapi.json` (public, no
authentication). Where this document and the spec disagree, the spec wins.

## Rate limits

Authenticated requests have separate per-app token buckets. The defaults are
120 read requests and 30 write requests per minute. Override them with
`NUXT_INTEGRATION_AUTH_READ_LIMIT` and
`NUXT_INTEGRATION_AUTH_WRITE_LIMIT`; each value must be an integer from 1 to
1,000,000. Reads are `GET` and `HEAD`; other methods use the write bucket.
Authenticated responses report the consumed bucket in `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset`. A 429 also includes `Retry-After`.

## Versioning

- The major version is part of the path: `/api/integrations/v1`. A new major
  version gets a new path (`/api/integrations/v2`) and runs alongside the old
  one for at least the deprecation notice period below.
- `info.version` in the spec follows semantic versioning. Its major number is
  always the path version; minor releases add compatible features; patch
  releases fix documentation or bring the implementation back in line with the
  spec.
- Every change to the spec is listed in the release notes of the release that
  ships it.

## Compatibility guarantees within v1

Within v1 the server will not, for any existing operation:

- remove or rename a path, operation, parameter, request or response field,
  header, scope, event type or error `code`;
- change a field's type or meaning, or turn an optional response field into
  an absent one;
- make an optional request field or parameter required, add a new required
  request field, or narrow the values a request field accepts;
- require a broader scope than before;
- change the webhook signature scheme `v1` (HMAC-SHA256 over
  `<timestamp>.<body>`, sent as `OpenFarm-Signature: v1=<hex>`) or the meaning
  of `OpenFarm-Event-Id` and `OpenFarm-Timestamp`.

Within v1 the server may, and clients must tolerate:

- new operations, paths, optional request fields and optional query
  parameters;
- new fields in response bodies and webhook payloads (ignore unknown fields);
- new values in response-only enumerations, including job and action
  `status`, `refusal.code`, problem `code` and event types a client did not
  subscribe to (treat an unknown status as not final, an unknown refusal code
  as a refusal and an unknown problem code by its HTTP status);
- new response headers, and new error responses using an already documented
  status code family;
- additional signatures in `OpenFarm-Signature` during secret or scheme
  rotation (accept the request if any `v1=` value verifies);
- changes to rate-limit budgets, token lifetime and page sizes within the
  documented bounds; clients follow `RateLimit-*`, `Retry-After`,
  `expires_in` and `nextCursor` instead of hard-coding them.

Security fixes are the only exception: when keeping a behaviour would expose
owners or printers to harm, it may change within v1 without notice, and the
release notes say so.

## Deprecation

- A feature is deprecated by marking it `deprecated: true` in the spec, noting
  it in the release notes, and sending `Deprecation` and `Sunset` response
  headers (RFC 9745, RFC 8594) on every call that uses it, with a `Link` to the
  release notes.
- A deprecated feature keeps working for the rest of v1: removal happens only
  in a new major version, never within v1.
- The notice period is at least **6 months** between the release that first
  announces a deprecation and the release of the major version that removes
  it, and at least **12 months** between the release of a new major version
  and the removal of the previous one (`/api/integrations/v1` keeps answering
  until then).
