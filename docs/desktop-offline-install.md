# Desktop offline dependency bundle (`linux-x64`)

The desktop installs with `npm ci --ignore-scripts` (`.npmrc` pins `ignore-scripts=true`) from a mirror that may lack recently published packages (`nuxt@4.6.4`, `vitest@5.1.0`, `typescript@7.0.2` installed as `typescript7`, `vue-tsc@3.3.14`, `@playwright/test@1.65.0`) or Linux x64 platform packages (`@node-datachannel/linux-x64-gnu`, `@esbuild/linux-x64`, `@rollup/rollup-linux-x64-gnu`, `@rolldown/binding-linux-x64-gnu`, `lightningcss-linux-x64-gnu`, `@typescript/typescript-linux-x64`, plus their `-musl` variants). A single missing tarball stops `npm ci`.

## 1. Report lockfile packages and mirror gaps

Run without network to list every `name@version` in `package-lock.json` and highlight platform packages:

```sh
node scripts/desktop-deps-report.mjs
```

Pass `--registry <url>` to check which pinned tarballs that mirror lacks:

```sh
node scripts/desktop-deps-report.mjs --registry https://mirror.example.invalid/npm
```

The report reads `package-lock.json` (`lockfileVersion` 3), maps aliased entries (such as `typescript7` -> `typescript@7.0.2`) to their real npm package name, marks platform packages (`os`, `cpu`, `libc`), marks bundled entries (`inBundle`), and lists every missing tarball without sending secrets.

## 2. Build the offline cache bundle on a connected machine

This is a manual workflow run on a connected machine. It stages the workspace manifests (`package.json`, `package-lock.json`, `.npmrc`, and workspace `package.json` manifests), runs `npm ci --ignore-scripts` for `linux-x64` (`glibc` and, when present in the lockfile, `musl`), verifies the cache, strips logs and request headers, and writes one `.tar.gz` archive containing only `_cacache/`:

```sh
node scripts/desktop-bundle.mjs
# or with an explicit output path / registry:
node scripts/desktop-bundle.mjs --out /tmp/open3dfarmmanager-npm-cache-linux-x64.tar.gz
```

Bundle hygiene guarantees:

- Contains only `_cacache/content-v2/` and `_cacache/index-v5/` (no `_logs/`, `_npx/`, `_prebuilds/`, `_update-notifier-last-checked`, `node_modules/`, `.npmrc`, or source files).
- Recomputes `index-v5` SHA-1 checksums after clearing `reqHeaders`, stripping sensitive `resHeaders` (`authorization`, `cookie`, tokens), and stripping URL userinfo.
- Built with `COPYFILE_DISABLE=1` so macOS AppleDouble (`._*`) metadata files never enter the archive.

## 3. Install and build offline on the desktop

Unpack the bundle into an empty cache directory and run `npm ci --offline`:

```sh
mkdir -p /tmp/openfarm-npm-cache
tar -xzf open3dfarmmanager-npm-cache-linux-x64.tar.gz -C /tmp/openfarm-npm-cache
npm ci --offline --ignore-scripts --cache /tmp/openfarm-npm-cache
npm run build
```

Existing protections stay unchanged:

- `.npmrc` keeps `ignore-scripts=true`. npm may still run local workspace `prepare` scripts; this project runs `nuxt prepare` in `apps/farm`.
- System Chrome/Chromium, Go `>= 1.26` (`build:rtsp-ingest`), and Docker container workflows remain separate opt-in prerequisites with no implicit downloads.

## 4. Documented fallback per Linux x64 platform package

Every Linux x64 platform package in `package-lock.json` is an `optional` dependency of a parent tool. When a single native package is missing or cannot execute on the target host, use the corresponding fallback below rather than bypassing integrity checks:

| Linux x64 package (lockfile pin)                                                     | Parent package     | Role                                                                                           | Fallback when missing                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@typescript/typescript-linux-x64@7.0.2`                                             | `typescript7`      | Root `npm run typecheck` (`node node_modules/typescript7/bin/tsc --noEmit`)                    | Run root typecheck using TypeScript 6 (`typescript@6.0.3`, already hoisted in root `node_modules/typescript` for `apps/farm` / `vue-tsc`): `node node_modules/typescript/bin/tsc --noEmit && npm run typecheck -w @open3dfarmmanager/farm`.                                                                                                                                                                                                             |
| `@node-datachannel/linux-x64-gnu@0.33.6` / `@node-datachannel/linux-x64-musl@0.33.6` | `node-datachannel` | Connector WebRTC peers and camera media (`packages/connector`, kept `external` in `build.mjs`) | `npm run build` and non-RTC tests pass without it. To restore WebRTC without the prebuilt tarball, compile locally in `node_modules/node-datachannel` (`npm run compile` via `cmake-js` + C++/`libdatachannel` deps) or place `node_datachannel.node` in `node_modules/node-datachannel/build/Release/`. Without it, WebRTC fails closed at dynamic import and the UI remains read-only (browser commands stay WebRTC-only with no TURN/HTTP fallback). |
| `@esbuild/linux-x64@0.28.2`                                                          | `esbuild`          | Connector build (`packages/connector/build.mjs`), Nitro, Vitest                                | Set `ESBUILD_BINARY_PATH` to a matching `0.28.2` `esbuild` executable on the host, or provide `esbuild-wasm@0.28.2` in a supplemental offline cache.                                                                                                                                                                                                                                                                                                    |
| `@rollup/rollup-linux-x64-gnu@4.68.7` / `@rollup/rollup-linux-x64-musl@4.68.7`       | `rollup`           | Nitro production server bundle (`npm run build -w @open3dfarmmanager/farm`)                    | Supply `@rollup/wasm-node` matching Rollup in a supplemental offline cache, or run `npm run build` on a connected/capable build host and deploy `apps/farm/.output/` (runtime `node .output/server/index.mjs` does not load Rollup; Connector builds with `esbuild`).                                                                                                                                                                                   |
| `@rolldown/binding-linux-x64-gnu@1.2.19` / `@rolldown/binding-linux-x64-musl@1.2.19` | `rolldown`         | Vite 8 client/SSR bundling in `apps/farm` build and Vitest                                     | Use `@rolldown/binding-wasm32-wasi@1.2.19` (pinned in `package-lock.json`; force with `NAPI_RS_FORCE_WASI=true`) or point `NAPI_RS_NATIVE_LIBRARY_PATH` at a local `.node` binding, or deploy prebuilt `apps/farm/.output/`.                                                                                                                                                                                                                            |
| `lightningcss-linux-x64-gnu@1.33.0` / `lightningcss-linux-x64-musl@1.33.0`           | `lightningcss`     | Vite 8 CSS transform/minification in `apps/farm` build                                         | Supply `lightningcss-wasm@1.33.0` offline, or build `apps/farm/.output/` on a host with the native binding (runtime serves prebuilt CSS under `.output/public` without loading `lightningcss`).                                                                                                                                                                                                                                                         |

## Candidate verification (issue #370)

On candidate `75196365dc11a27f47d056e50065366e84161134`, an isolated
Linux x64 QEMU guest with Node 22.23.5 and npm 10.9.9 generated the default
archive with `node scripts/desktop-bundle.mjs`: 605 blobs and 605 index
entries, for glibc and musl. The documented `--out` variant also produced
605 blobs and 605 index entries. The documented `mkdir` and `tar -xzf`
commands prepared the cache. `npm ci --offline --ignore-scripts --cache`
succeeded in a network namespace with only loopback enabled (628 packages
installed). In that same namespace, `npm run build` succeeded, and
`node --test tests/node/e16-370-dev.test.mjs` started the README's
`npm run dev` and received HTTP 200 from `/farm`. The first test attempt saw
Nuxt's startup 503; the test now waits for readiness. npm's log also showed
`nuxt prepare` running during installation.

README command coverage: the install and build are exercised by
`tests/node/e16-370.test.mjs` on a clean tree; the dev command is exercised
by `tests/node/e16-370-dev.test.mjs`; the same README test runs
`desktop:check -- --only app-smoke` and `desktop:check -- --list`. The
work order supplies earlier clean isolated ARM64 evidence for install, build,
local PostgreSQL, dev and built `/farm`, `sim:verify`, Chrome app-smoke and a
mock printer card. That earlier evidence was not rerun here. The x64 guest did
not run Chrome, so its results establish archive consumption and build, not
browser or printer-card acceptance. No combined suite was run in this check.
