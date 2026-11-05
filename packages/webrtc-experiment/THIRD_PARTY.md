# WebRTC experiment dependency review

Reviewed 2026-11-04 against the root `bun.lock` and the installed packages. The experiment uses native Chromium WebRTC and Web Crypto through Playwright. Both peers run in the browser; the synthetic Connector is not a Node.js or Bun WebRTC implementation. This does not establish Connector runtime, hardware, camera, or production network compatibility.

| Package            | Version | Declared license | Declared runtime dependencies |
| ------------------ | ------- | ---------------- | ----------------------------- |
| `@playwright/test` | 1.64.1  | Apache-2.0       | `playwright@1.64.1`           |
| `playwright`       | 1.64.1  | Apache-2.0       | `playwright-core@1.64.1`      |
| `playwright-core`  | 1.64.1  | Apache-2.0       | None                          |

These are existing development dependencies, not new WebRTC libraries. The complete license and notice files shipped by each installed package are retained in `notices/`; the two packages that ship `ThirdPartyNotices.txt` retain those files too. Preserve applicable Apache-2.0 license, attribution and notice materials when redistributing these packages or their covered portions. These copies do not constitute an audit of all root dependencies or of a resulting distribution.

Playwright's installed `browsers.json` specifies Chromium revision 1248, version 156.0.8078.4, including the headless shell. The browser is a separately downloaded executable with its own bundled third-party components and notices. It is not included in this repository or covered by the Playwright notices here. If distributing a browser binary, inspect and retain its applicable notices and license materials. The installed metadata establishes the expected browser build, not which executable a particular test run actually launched.

## Candidates for a future Connector experiment

These packages were not installed, incorporated, or tested. Their registry metadata was inspected on 2026-11-04; no complete dependency or binary license closure was audited. Pin and review the complete resolved closure and distribution materials before adopting either.

- [`werift@0.26.0`](https://registry.npmjs.org/werift/0.26.0) declares MIT, Node `>=22`, and dependencies `buffer`, `mediabunny`, and `multicast-dns`. Its [project](https://github.com/shinyoshiaki/werift-webrtc) describes a TypeScript Node WebRTC implementation. Node 24 satisfies the declared engine, but interoperability, security, and Bun support have not been verified here. Its license label does not establish the licenses of its dependencies.
- [`node-datachannel@0.33.5`](https://registry.npmjs.org/node-datachannel/0.33.5) declares MPL-2.0 and Node `>=18.20.0`, so Node 24 satisfies the declared engine. Its [upstream documentation](https://github.com/murat-dogan/node-datachannel) describes native libdatachannel bindings and platform-specific prebuilt packages. Review MPL source availability obligations and all bundled native components before distribution. Bun support and the actual target platform have not been verified here.

Neither a declared Node engine nor a browser-only peer test proves a Node 24 or Bun Connector works. A future evaluation needs a pinned dependency and notice review, real cross-runtime browser-to-Connector tests, and Connector-side safety enforcement. No AGPL, BSL, or FSL implementation code was copied for this experiment.
