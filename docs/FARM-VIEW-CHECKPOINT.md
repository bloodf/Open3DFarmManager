# E6 frontend implementation checkpoint

E6 remains incomplete. This slice supplies authenticated HTTP inventory, scoped read-only presentation, an unconnected status-consumer port, and explicit local-interface bookmarks held in tab memory. It does not establish genuine browser-to-Connector status, camera, or command acceptance.

The implementation started from `e7ae65eb81dcbfed838c8e571f6fddb39c69aa68`. Concurrent documentation advanced the shared branch to `43948542a802384e7ae6550a7a214593645816db` during this task. The coordinator records the resulting candidate commit and built-artifact identity when the remaining integration work settles. No application artifact was built in this task.

## Implemented behavior

`apps/farm/app/pages/farm.vue` retains its existing feature gate. The page uses native controls, pt-BR copy, focusable headings and error summaries, wrapped exact printer keys, separate assignment and Connector approval labels, and an unconditionally disabled pause button. The root coordinator owns the conditional home navigation link. Login and existing management pages are unchanged.

`apps/farm/app/utils/farm-view.ts` validates current-account, farm-discovery, assignment, and registry responses before presentation. Farm and assignment pages replace previous pages, request 20 rows, and use actual UUID cursors. Only a complete first discovery page containing one farm is auto-selected. Names, printer counts, URLs, and operational state are never inferred from inventory. Loading, empty results, authentication failures, forbidden access, rate limits, malformed responses, and unavailable services remain distinct.

Current-account reads bracket discovery and assignment reads. Registry pages also carry `currentAccountId`. Approved local keys are joined by current account and exact thumbprint to approved registry key IDs with recorded possession proof. All registry pages must be read before selection. The scan stops after 32 pages and reports an incomplete result without claiming that an unseen key is missing. Multiple candidates require selection. Local enumeration uses `listDeviceKeys`; it never invokes key creation, enrollment, recovery, or legacy key fallback. Storage or registry failures leave independently confirmed inventory readable, but observed 401, 403, or account mismatch clears private state.

`apps/farm/app/composables/useFarmView.ts` holds state per mounted page without an authenticated Nuxt singleton or private server-rendered payload. Selection, refresh, pagination, key changes, route exit, and disposal invalidate callbacks before aborting pending reads and closing feeds. Scope changes clear observations and local links conservatively, including inventory refreshes. Focus, visibility changes, `pageshow`, and `pagehide` suspend private presentation and revalidate when visible. The optional `open3dfarmmanager:auth-invalidated` window event only triggers invalidation and fresh reads. Existing auth pages do not emit this event yet.

Two `/api/auth/me` reads do not provide an atomic session snapshot. Farm and assignment responses do not echo an account or session generation, cookie changes are not directly observable, and equal account IDs do not detect session rotation. Immediate cross-tab revocation and real account-switch races remain auth and transport acceptance requirements.

## Status-consumer contract

The production composable passes no feed. Inventory therefore displays `Conexão direta indisponível` and `Nenhum estado recebido`. No experiment peer or synthetic producer is imported into application runtime.

The exported `FarmStatusFeed` opens one read-only subscription per eligible Connector on the current assignment page:

```ts
open({
  scope, // accountId, farmId, viewEpoch
  agentId,
  assignmentRefs, // assignmentId, agentId, exact printerKey
  browserKeyId,
  signal,
  onHealth,
  onSnapshot,
}): { close(): void }
```

The producer must authorize the current session, membership, browser key, Connector, and assignments. It must verify the actual RTC transcript, certificate, and mutual proofs before emitting `authenticated`. `FarmAdmittedSession` is display metadata, not an authorization credential. It contains `transportId`, `peerGeneration`, `accountId`, `farmId`, `agentId`, `browserKeyId`, `expiresAt`, and `deadlineMonoMs`. Private keys, bearer credentials, proofs, and SDP never enter page state.

`FarmSnapshot` contains that fixed session, a protocol `StatusMessage`, local receipt timestamps `receivedAtWallMs` and `receivedAtMonoMs`, explicit `sourceClockComparable`, and `complete: true`. The producer must define complete snapshots for the subscribed Connector and fit the existing 2,048-byte application-frame budget. Raw-frame decoding must reject duplicate JSON properties and enforce the actual wire-byte limit before producing this parsed callback. The consumer additionally validates strict protocol schemas, safe timestamps and sequence numbers, duplicate printer keys, and the serialized parsed-message budget. This check does not replace producer wire validation or widen the peer budget. No chunking protocol is introduced.

The consumer checks the exact view, assignment, key, transport, and peer generation. Only increasing sequence numbers update observations. Missing printers become historical without a refreshed age. Extra keys never create inventory rows. Regressing source timestamps and changed content at an equal timestamp retain the previous observation as uncertain history. Repeated identical source data cannot hide a clearly old source observation.

Receipt age uses monotonic time. The display stale threshold is 30 seconds, inclusive. A comparable old source timestamp also marks data stale. Future source time, clock regression, or wall-to-monotonic divergence removes source-time confidence. The page reports uncertainty and never labels a recent packet as verified fresh printer data. Transport state remains separate from last printer state.

The consumer closes terminally at the original session deadline, wall-clock expiry, or 30 seconds after subscription, whichever occurs first. The producer remains responsible for its own stricter local expiry and current authority. Repeated authentication callbacks cannot change the original session or extend its lease. Disconnect, rejection, revocation, and expiry leave only same-scope historical observations, and late callbacks cannot restore a closed feed. A new genuinely admitted transport requires a new subscription.

The genuine adapter owner must supply this producer and document its bounded publishing strategy and capacity behavior. Opening a WebSocket, ICE connectivity, registry approval, a proof fixture, or `fixture-idle` cannot satisfy this contract. There is no command, signing, media, arbitrary-URL fetch, HTTP status fallback, or TURN method on the port.

## Local-interface navigation

Each eligible active row accepts an explicit HTTP or HTTPS root origin with a labeled confirmation checkbox. The page shows the normalized origin before retention. Credentials, whitespace, control characters, backslashes, query strings, fragments, non-root paths, and path-normalization tricks are rejected locally. Private DNS, private IPs, and loopback remain deliberate supported destinations.

The confirmed origin stays inside the current account, farm, assignment, Connector, and exact-key row in tab memory. Scope invalidation, assignment replacement, or revocation removes it. There is no persistence, server write, address probe, prefetch, proxy, iframe, or programmatic window opening. The external anchor uses `target="_blank"`, `rel="noopener noreferrer"`, and `referrerpolicy="no-referrer"`. Clicking is ordinary explicit browser navigation, independent of application command authority.

## Verification and remaining gates

The coordinator released the CPU restriction for focused tests, formatting, and static typing. These checks passed:

- `bun test tests/unit/farm-view.test.ts`: 24 tests, 161 assertions. All feed events are explicitly synthetic unit inputs.
- Standalone strict TypeScript over the utility, unit tests, and opt-in e2e file, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled.
- `apps/farm/node_modules/.bin/vue-tsc --noEmit --incremental false -p apps/farm/.nuxt/tsconfig.app.json`, using the pre-existing generated app configuration without Nuxt preparation or build.
- Prettier on the six owned files and `git diff --check`.

`tests/e2e/farm-view.spec.ts` adds three isolated UI scenarios for native controls, 320px layout, exact escaped keys, external-anchor privacy attributes, no outbound local-address probe, focus invalidation, sign-in, and service failure. These tests are gated by `FARM_VIEW_E2E=true` and require a separately supplied built app with `farmView` enabled. They were not run here. Mocked routes cannot prove genuine login, database, or RTC behavior. The default flag-off suite is unchanged.

The following integration evidence is still required on one immutable candidate: `bun run check:all`; built HTTPS own-login and home-to-farm navigation; real PostgreSQL pagination and authorization scopes; approved nonextractable local browser keys; genuine admitted direct RTC simulator observations; stopped-feed age behavior; account, session, assignment, and revocation races; outages and bounded recovery; deliberate isolated local-interface navigation; keyboard, screen-reader, contrast, and responsive review. Signed pause and camera retain separate acceptance gates. No physical-printer command is authorized or tested by this slice.

No dependency was added. No install, build, browser, network, database, container, simulator, worktree, or persistent application process was started. Focused checks created no task-owned build output. Pre-existing dependencies, generated Nuxt files, application output, worktrees, processes, and other workers' edits were preserved. The outside-repository task ledger retains the resource baseline and bounded verification evidence. No publication or deployment occurred.
