# RTSP ingest source provenance

This source-only package retains 29 audited module trees. `manifest.json` lists every retained source file and SHA-256, upstream metadata, two synthetic proxy module files and the two incomplete historical h1 exceptions, and binary fixtures and archives omitted from this package. Local changes and omitted binary fixtures mean the retained trees are not authenticated by the upstream h1 values. The patches are applied in manifest order; gortsplib's SEI correction follows its validated patch. The upstream module files and sums remain unchanged, except for the two identified synthetic proxy go.mod files that upstream archives lacked.

`THIRD_PARTY_NOTICES.txt` retains the 44 selected-graph source notices, including graph-only and test material. Individual source headers and legal files remain in the trees. Original project contributions use the repository MIT license. `module-graph.json` is a proposed graph, not a compiler-selected helper closure. Future binary distributions require a separate review of the actual linked closure, Go standard library and vendor licenses and patents.

Run `python3 third_party/rtsp-ingest/verify.py` for a source-only integrity check. It does not compile, execute Go, verify an upstream h1, or establish runtime acceptance.

The repository Renovate configuration disables dependency updates for this path, because every retained byte is pinned by `manifest.json`. An upstream version bump needs a manual provenance re-audit and a manifest update before any vendored file changes.

Binary fixture omissions can prevent upstream tests from running. The x/net public suffix tables remain as embedded data required by source, not executable binaries.
