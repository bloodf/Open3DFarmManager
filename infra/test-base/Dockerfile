# SPDX-License-Identifier: MIT
# Dependency image for Docker test runs, one per lockfile and Node image.
# Built only by scripts/docker-base-image.mjs, whose build context holds just
# package-lock.json, .npmrc and the workspace manifests.
# The caller supplies the same source image checked by the offline guard.
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
FROM ${NODE_IMAGE}
USER root
WORKDIR /opt/openfarm-deps
COPY . .
RUN npm ci --no-audit --no-fund \
 && (npm rebuild node-datachannel || echo 'node-datachannel rebuild skipped') \
 && npm cache clean --force
