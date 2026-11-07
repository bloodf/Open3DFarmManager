# Pause RTC consumer source checkpoint

This test-only consumer extends the maintained HTTPS fixture. It uses real enrollment, pairing, assignment readback, issuer handlers, signing and authenticated WebRTC clients. The trusted child provisions an opaque binding to its own synthetic loopback Moonraker. The dispatcher prepares the maintained router only after authority checks. The command carries no endpoint. There is no HTTP printer command or TURN fallback.

Opt in through `scripts/test-signalling-https.ts` using both `SIGNALLING_HTTPS_PAUSE_RTC_FIXTURE=yes` and `SIGNALLING_HTTPS_PAUSE_EXECUTION_RTC_FIXTURE=yes`. Existing disposable fixture, private ledger, HTTPS and Linux native prerequisites still apply. Select one row with `SIGNALLING_HTTPS_PAUSE_EXECUTION_ROW`.

| Row           | Source oracle                                                                                           | Boundary                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `standard`    | One correlated applied pause, paused observation, replay adds no pause                                  | Real HTTPS authority and RTC; synthetic Moonraker              |
| `revocation`  | Actual connector revoke handler closes session; zero preparation and pause                              | Before browser pause request                                   |
| `disconnect`  | Actual signalling disconnect closes session; zero pause and command HTTP fallback                       | Before browser pause request                                   |
| `stale`       | Signed command held after RTC receipt; local verifier clock advances; zero preparation and pause        | Test-only clock, not issuer response fabrication               |
| `reassigned`  | Signed command held after RTC receipt; trusted local binding retired; zero preparation and pause        | Local retirement, not a database reassignment acceptance claim |
| `peer-closed` | Signed command held after RTC receipt; peer signal aborted; zero preparation and pause                  | Owner cancellation                                             |
| `late-close`  | Real driver closes; test barrier retains close completion; owner settlement stays pending until release | One authorized pause; no restart or replacement is exposed     |

The journal and simulator stay owned until relay closure and actual settlement. A rejected or unresolved close retains ownership; the child cannot start twice. Forced process cleanup is a failed gate, never successful settlement. Supplemental signed relay tests exercise fresh, revoked, stale, retired binding and closed peer cases without HTTPS; their keys are test keys and their results cannot establish HTTPS admission acceptance.

All rows are source-only and UNRUN on this Mac. Linux must run formatting, type checks, root checks, native RTC and isolated simulator gates on the exact source head. Fresh independent source review is required. The existing unrelated simulator tests are unchanged. Synthetic HTTP/WebSocket Moonraker is not real Klipper acceptance, and no full Phase 0 acceptance is claimed.
