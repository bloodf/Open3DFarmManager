# SPDX-License-Identifier: MIT
# Dependency image for Docker test runs, one per lockfile and Node image.
# Built only by scripts/docker-base-image.mjs, whose build context holds just
# package-lock.json, .npmrc and the workspace manifests.
# Digest matches node:22.23.5-bookworm-slim pinned in infra/sandbox/compose.yml.
FROM node:22.23.5-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
USER root
WORKDIR /opt/openfarm-deps
COPY . .
RUN npm ci --no-audit --no-fund \
 && (npm rebuild node-datachannel || echo 'node-datachannel rebuild skipped') \
 && npm cache clean --force
