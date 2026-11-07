# Credential expiry diagnostic archive (2026-11-05)

Commit [94de7d3a77ae472d10289e7246e67993cf1bf443](https://github.com/bloodf/Open3DFarmManager/commit/94de7d3a77ae472d10289e7246e67993cf1bf443) preserved an experiment in [the original test file](https://github.com/bloodf/Open3DFarmManager/blob/94de7d3a77ae472d10289e7246e67993cf1bf443/tests/unit/connector-agent-runtime.test.ts). Its Git blob is `4f1ac091670724c88fd30ecaa1db5bf43fe36488`.

The experiment allowed `AGENT_EXPIRY_WINDOW_MS` to override the credential expiry window, defaulting to 1500 ms. When `AGENT_EXPIRY_TRACE` was set, it logged elapsed expiry and queue times, queue depth, cloud request and server counts, and timestamped output chunks. The [original diff](https://github.com/bloodf/Open3DFarmManager/commit/94de7d3a77ae472d10289e7246e67993cf1bf443) preserves the exact instrumentation.

This was a diagnostic checkpoint. It does not establish acceptance or a passing runtime gate. The active test now uses the deterministic expiry and delivery sequence from main. The historical override is not an active test option.
