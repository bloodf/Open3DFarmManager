# node-datachannel native binary provenance

The Connector uses node-datachannel 0.33.6, distributed under MPL-2.0. Its platform binaries come from the npm packages `@node-datachannel/<platform>@0.33.6` at https://registry.npmjs.org/@node-datachannel/; the package lock records their tarball URLs and integrity values. The registry identifies the wrapper source as https://github.com/murat-dogan/node-datachannel/tree/6f5c0a2494c20ac9f1250d937856697843bde823.

The SHA-256 values for the extracted `node_datachannel.node` files are recorded in `verify-native.mjs`. The Connector build verifies the installed platform binary against that list and fails if it is missing or differs. These hashes identify published binaries; they do not prove a reproducible build or independently establish the licenses of embedded components. See the repository THIRD_PARTY.md for the outstanding embedded-component review and retained notices.

## Installed macOS arm64 artifact

The installed npm prebuilt matched SHA-256
`325829afa497aaf11e2d2ebb18c0232cc57c4b802adfd1b405327ffdca4ee8d6`.
The wrapper's installed MPL-2.0 text matched the retained
`notices/node-datachannel/node-datachannel-LICENSE` byte for byte. The wrapper
source selects libdatachannel v0.24.6 (commit
`6b1e2e620f1e37f0eafeee702eaea0043cb305fd`).

The macOS artifact exposes `juice_create`, `usrsctp_init`, `srtp_init` and
`SSL_do_handshake` symbols. Its linked libraries are macOS system libraries
and it contains the string `OpenSSL 3.6.3 9 Jun 2026`. These observations
support including the retained libjuice, usrsctp, libsrtp and OpenSSL notices.
The Connector bundle carries the existing node-datachannel notice directory
alongside this record. The other notices are retained for source reference.
Exact embedded component revisions, the completeness of the retained notices
for 0.33.6, and binary evidence on other platforms remain open for
redistribution review.
