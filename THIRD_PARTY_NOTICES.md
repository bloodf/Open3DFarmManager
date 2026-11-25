# Third-party notices

For each file copied or adapted from an upstream project, include its SPDX license identifier and a `Ported from <repo>@<commit>:<path>` line in the file header. Use the upstream repository, full commit SHA and original file path. Retain upstream copyright and license notices, and add an entry here.

## Included sources and reference material

- **RTSP ingest Go sources.** The [source manifest](third_party/rtsp-ingest/manifest.json) records upstream modules, revisions and source files. The [RTSP ingest notices](third_party/rtsp-ingest/THIRD_PARTY_NOTICES.txt) retain the upstream license texts. See the [provenance notes](third_party/rtsp-ingest/README.md) for local patches and omissions.
- **Spoolman API reference.** The [upstream lock](third_party/spoolman-reference/upstream.lock.json) records the source revision. The [upstream MIT license](third_party/spoolman-reference/LICENSE) accompanies the reference material.
- **caniuse-lite 1.0.30001826.** Browser-support data is sourced from [Can I use](https://caniuse.com/) via [caniuse-lite](https://github.com/browserslist/caniuse-lite/tree/942f16cd659e11288cfffbda649f9d650e4500c4). The upstream dataset is adapted into a compact subset by caniuse-lite; this repository makes no further known changes to the pinned package. It is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), which includes a disclaimer of warranties. The [upstream README](https://github.com/browserslist/caniuse-lite/blob/942f16cd659e11288cfffbda649f9d650e4500c4/README.md) requests attribution to caniuse.com. Upstream also incorporates browser compatibility data from other sources; this notice does not establish a complete feature-level attribution inventory.
- **Anycubic slot report reference.** The Kobra and ACE Pro slot mapping (`packages/connector/src/anycubic/ace.ts`) and its fixtures (`tests/fixtures/anycubic/ace/`) follow report shapes and rules read from [kobracontrol](https://github.com/bloodf/kobracontrol/tree/ed298ff44f48a5ed2db0ac08e7e19243d542e14c) and [spooler](https://github.com/bloodf/spooler/tree/911dc7efa8d2a6c24b445170d9af34f28dbb9658), both GPL-3.0. No source file is copied or ported.
- **Spool illustration (orca-ui-foundation).** `FarmSpool.vue`, `FarmSlot.vue` and `FarmLevel.vue` in `apps/farm/app/components/spool-art/` are ported from `OuiSpool.vue`, `OuiSlot.vue` and `OuiLevel.vue`, and the fifteen WebP renders in `apps/farm/public/spool-art/` are copied unchanged from `src/assets/spool/`, all of [bloodf/orca-ui-foundation@e4d93af0cf576660ad4b80ac5d5a1cdef4a5c795](https://github.com/bloodf/orca-ui-foundation/tree/e4d93af0cf576660ad4b80ac5d5a1cdef4a5c795), licensed under the MIT License below. Each ported file keeps an SPDX line and a `Ported from` header.
- **Dependencies and reference projects.** See [THIRD_PARTY.md](THIRD_PARTY.md) for existing dependency notices and attribution.

## node-datachannel native packages

The lockfile pins `node-datachannel` and its nine optional platform packages to 0.33.6. The exact npm tarballs match the lockfile SHA-512 integrities; each contains a package manifest and a native binary, and each manifest declares `MPL 2.0` (MPL-2.0):

| Package `@node-datachannel/…` | Version | Declared license |
| ----------------------------- | ------- | ---------------- |
| `android-arm64`               | 0.33.6  | MPL-2.0          |
| `darwin-arm64`                | 0.33.6  | MPL-2.0          |
| `darwin-x64`                  | 0.33.6  | MPL-2.0          |
| `linux-arm64-gnu`             | 0.33.6  | MPL-2.0          |
| `linux-arm64-musl`            | 0.33.6  | MPL-2.0          |
| `linux-x64-gnu`               | 0.33.6  | MPL-2.0          |
| `linux-x64-musl`              | 0.33.6  | MPL-2.0          |
| `win32-arm64-msvc`            | 0.33.6  | MPL-2.0          |
| `win32-x64-msvc`              | 0.33.6  | MPL-2.0          |

The npm release metadata identifies [node-datachannel revision `6f5c0a2494c20ac9f1250d937856697843bde823`](https://github.com/murat-dogan/node-datachannel/tree/6f5c0a2494c20ac9f1250d937856697843bde823); its [manifest](https://github.com/murat-dogan/node-datachannel/blob/6f5c0a2494c20ac9f1250d937856697843bde823/package.json) lists all nine packages, and its [license](https://github.com/murat-dogan/node-datachannel/blob/6f5c0a2494c20ac9f1250d937856697843bde823/LICENSE) is MPL-2.0. The [build configuration](https://github.com/murat-dogan/node-datachannel/blob/6f5c0a2494c20ac9f1250d937856697843bde823/CMakeLists.txt) fetches [libdatachannel v0.24.6](https://github.com/paullouisageneau/libdatachannel/tree/v0.24.6) and links its static target; it also finds OpenSSL. The upstream package metadata is provenance information, not proof that the binaries were reproducibly built from that source. The platform tarballs do not contain license or source files, and their complete bundled dependency versions, notices and corresponding source have not been independently established. Preserve applicable upstream notices and satisfy source-availability obligations when distributing these binaries; do not treat this inventory as a complete binary license clearance.

## Previous project notice

The following copyright and permission notice accompanies project code previously distributed under the MIT license.

```text
MIT License

Copyright (c) 2026 Heitor Ramon Ribeiro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## orca-ui-foundation notice

The spool illustration components (`SpoolIllustration`, `FarmSpool`,
`FarmSlot`, `FarmLevel`) and the layered reel renders in
`apps/farm/app/assets/spool` and `apps/farm/public/spool-art` are adapted from
[bloodf/orca-ui-foundation](https://github.com/bloodf/orca-ui-foundation/tree/e4d93af0cf576660ad4b80ac5d5a1cdef4a5c795)
(commit `e4d93af0cf576660ad4b80ac5d5a1cdef4a5c795`), copyright 2026 bloodf.
The source is MIT licensed; its notice is reproduced below and retained in
[`notices/orca-ui-foundation-MIT.txt`](notices/orca-ui-foundation-MIT.txt).

```text
MIT License

Copyright (c) 2026 bloodf

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
