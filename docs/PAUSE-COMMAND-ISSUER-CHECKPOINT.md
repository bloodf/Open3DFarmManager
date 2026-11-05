# Pause command issuer checkpoint

This slice adds the production browser HTTP adapter of the pause command
issuer. It is a source-only slice: the adapter is not wired into a page, into
the pause command client runtime or into any deployment. The checkpoint records
focused boundary evidence, not an accepted pause path.

## Public surface

`apps/farm/app/utils/webrtc/pause-command-issuer.ts` exports:

- `createPauseCommandIssuer(options?)`, which returns the existing
  `PauseCommandIssuer` contract of `pause-command-client.ts`.
- `PauseCommandIssuerError`, with a closed `reason` of `aborted`, `timeout`,
  `origin`, `request`, `response` or `status`.
- `PauseCommandIssuerOptions`, with an optional injected `fetch` and an
  optional injected `currentOrigin`. Both exist for deterministic tests.

The factory is inert. It performs no request, creates no key, reads no session
and starts no timer. Every network activity begins with an explicit `challenge`
or `capability` call.

## Maintained route and wire contract

The adapter calls only the two maintained pause authority routes of the same
origin, `POST /api/pause-authority/challenges` and
`POST /api/pause-authority/capabilities`. The request body is exactly the
maintained shape of `apps/farm/server/services/pause-authority-http.ts`:
`browserProofWire`, `connectorProofWire` and `admissionNonce` for a challenge,
`admissionProofWire` for a capability. Each inner wire keeps its maintained
8192 byte limit and the outer body stays inside the maintained 100 KiB and
50 KiB limits. A request outside those shapes fails closed before any byte
leaves the page.

Every request carries `credentials: 'same-origin'`, `cache: 'no-store'` and
`redirect: 'error'`. The only header is `content-type: application/json`. There
is no alternate URL, no discovery, no fallback route, no custom authorization
header and no automatic retry.

The response envelope is the maintained one: `{ challenge }` and
`{ capability }`, parsed with the strict maintained schemas. The adapter does
not read a scope, does not verify a signature and does not infer authority.
Those decisions stay with the pause command client and the Connector.

## Bounds and failure behavior

The origin is validated explicitly on every call. It must be the plain HTTPS
origin of the current page. A non HTTPS origin, an origin with a path and an
injected origin that differs from the current page origin all fail closed
before the request.

Each request has one deadline of two seconds, armed before the fetch and never
renewed. A body that keeps arriving does not extend it. The caller abort
signal is mandatory: a missing signal fails closed without a request.

The response is read as a stream. The limit is 16384 raw UTF-8 bytes, the
decoding is strict, and the JSON parse is bounded. An invalid encoding, a
duplicate key, a wrong type, an unknown field, a wrong status, a redirect and
a missing body all fail closed. A response that arrives after the adapter gave
up is disposed and never delivered, and the reported failure never claims that
issuance did not happen. A timeout reports that the issuance state is unknown.

## Evidence and limits

Fifteen focused Node tests passed at the base head `a8c6c7c`. They exercise
the real Fetch `Response` and `ReadableStream` objects, the exact request
bodies and flags, the response size and encoding limits, the cancellation of
a refused stream, the two second deadline, the caller abort, the late
response disposal and the inert factory. The suite runs without an HTTP
server, without a network, without a browser and without any authority stub:
the challenge and the capability are real values, and the capability is signed
by a real nonextractable Ed25519 issuer key.

Scoped strict TypeScript and Prettier checks passed for the two owned files.
The neighbouring pause command client suite still passes with 24 tests.

The focused run borrowed the installed dependencies of the root checkout
through symlinks. No install, no build, no network, no listener, no container,
no PostgreSQL, no browser and no printer were used. The complete repository
`bun run check:all` gate remains pending on the integrated head and belongs to
the coordinator.

## Remaining acceptance

This slice does not establish a real HTTPS request from a page, the wiring of
the adapter into the pause command client runtime, the authenticated browser
session cookie on the maintained routes, the browser to Connector RTC
admission with the issued capability, or a paused simulator. Those steps stay
open, and the repository gate still has to pass on the integrated head before
any publication.
