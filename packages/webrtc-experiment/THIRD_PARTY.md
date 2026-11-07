# WebRTC experiment dependency review

Historical review, 2026-11-04, against the root `bun.lock` and the installed packages. The original browser-only fixture uses native Chromium WebRTC and Web Crypto through Playwright, with a synthetic Connector peer running in Chromium. The interop fixture also uses a separate native Connector peer through `node-datachannel@0.33.5`. The [root dependency review](../../THIRD_PARTY.md#experimental-connector-webrtc-dependency) records its licenses, native source and prebuild provenance limits. See the experiment README and test output for the runtime evidence. Neither fixture establishes hardware, camera, production network compatibility or distribution readiness.

Current manifests pin `node-datachannel@0.33.6`; the generated pnpm lock update is pending. The 0.33.5 observations below remain historical evidence; renewed native and platform acceptance for 0.33.6 is pending. See the [current root provenance](../../THIRD_PARTY.md#experimental-connector-webrtc-dependency).

| Package            | Version | Declared license | Declared runtime dependencies |
| ------------------ | ------- | ---------------- | ----------------------------- |
| `@playwright/test` | 1.64.1  | Apache-2.0       | `playwright@1.64.1`           |
| `playwright`       | 1.64.1  | Apache-2.0       | `playwright-core@1.64.1`      |
| `playwright-core`  | 1.64.1  | Apache-2.0       | None                          |

These are existing development dependencies, not new WebRTC libraries. Their top-level `LICENSE` and `NOTICE` files are retained in `notices/`; the two packages that ship `ThirdPartyNotices.txt` retain those files too. Bundled-code license sidecars referenced by those notices are not retained here, so this is not a complete inventory of the packages' license materials. Before redistributing these packages or their covered portions, inspect the exact distributed contents and retain all applicable licenses, attributions and notices, including those sidecars. These copies do not constitute an audit of all root dependencies or of a resulting distribution.

Playwright's installed `browsers.json` specifies Chromium revision 1248, version 156.0.8078.4, including the headless shell. The browser is a separately downloaded executable with its own bundled third-party components and notices. It is not included in this repository or covered by the Playwright notices here. If distributing a browser binary, inspect and retain its applicable notices and license materials. The installed metadata establishes the expected browser build, not which executable a particular test run actually launched.

## Rejected candidate

`werift@0.26.0` was installed and exercised in a local two-peer smoke test on Node 24 and Bun. It was rejected for authenticated transport after static review found apparent missing DTLS handshake signature checks. The [root dependency review](../../THIRD_PARTY.md#experimental-connector-webrtc-dependency) records the source locations and limits of that finding. No exploit was run.

No AGPL, BSL, or FSL implementation code was copied for this experiment.
