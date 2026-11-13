# KobraLink Self-Hosting Guide

This document describes self-hosting configuration and operation for KobraLink integrated into Open3dFarmManager (OpenFarm).

## Prerequisites

- Node.js and pnpm installed according to repository conventions.
- Operator access to OpenFarm with a dedicated database and segregated environment credentials.
- Configured secure HTTPS farm origin.

## KobraLink Configuration

Source retrieval and upstream script integration are supported via `scripts/kobralink-source.mjs` and `THIRD_PARTY.md`.

1. **Upstream Retrieval and Licensing**: Use the dedicated source script to pull compatible upstream packages. Third-party notices and licenses are maintained in `THIRD_PARTY.md`. No proprietary upstream certificate material is redistributed.
2. **Secure Transport and Authentication**: The local connector manages crypto pairing and end-to-end WebRTC transport. Video streams and command paths travel strictly over the WebRTC tunnel—no HTTP command fallback or TURN relay.
3. **Machine Account Bootstrap**: Connector service accounts complete automated onboarding without requiring continuous manual operator intervention at the printer.

## Operation and User Experience

- Farm operators and users interact exclusively through the OpenFarm interface.
- No iframe embedding or public exposure of KobraLink management ports is required.
- Degraded network conditions fall back strictly to read-only status.

## Failure Recovery

- **Stale or Unknown State**: Inspect connector service logs and local status paths.
- **Unacknowledged Sync**: The protocol uses signed configuration inventory acknowledgements to ensure state consistency.
- **Unsupported Controls**: Local printer safety enforcement remains active in the connector even during central server outages.
