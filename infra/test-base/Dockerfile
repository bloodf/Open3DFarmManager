# SPDX-License-Identifier: MIT
# Dependency image for Docker test runs, one per lockfile and Node image.
# Built only by scripts/docker-base-image.mjs, whose build context holds just
# package-lock.json, .npmrc and the workspace manifests.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
USER root
WORKDIR /opt/openfarm-deps
COPY . .
RUN npm ci --no-audit --no-fund \
 && (npm rebuild node-datachannel || echo 'node-datachannel rebuild skipped') \
 && npm cache clean --force
