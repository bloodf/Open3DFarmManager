# SPDX-License-Identifier: MIT
# Dependency image for Docker test runs, one per lockfile and Node image.
# Built only by scripts/docker-base-image.mjs, whose build context holds just
# package-lock.json, .npmrc and the workspace manifests.
# Digest matches node:22.23.5-bookworm-slim pinned in infra/sandbox/compose.yml.
FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
USER root
WORKDIR /opt/openfarm-deps
COPY . .
RUN npm ci --no-audit --no-fund \
 && (npm rebuild node-datachannel || echo 'node-datachannel rebuild skipped') \
 && npm cache clean --force
