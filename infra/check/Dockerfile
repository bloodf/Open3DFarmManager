FROM golang:1.26.0-bookworm@sha256:2a0ba12e116687098780d3ce700f9ce3cb340783779646aafbabed748fa6677c AS go
# Debian 13 (trixie) ships git >= 2.42 (`worktree add --orphan`). Keep linux/amd64.
FROM node:24.22.3-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4

ARG TARGETARCH
RUN test "${TARGETARCH}" = amd64 || { echo 'The check image requires linux/amd64' >&2; exit 1; }
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg fonts-liberation git python3 libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    openssl ripgrep unzip \
 && rm -rf /var/lib/apt/lists/*

# Playwright resolves its Linux chrome channel to /opt/google/chrome/chrome.
RUN curl -fsSL --retry 3 \
    https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/linux64/chrome-linux64.zip \
    -o /tmp/chrome.zip \
 && echo 'dba9cc838e1ce269c33ea68170881127bd15d078fc3ca5891c90802819a4d7c7  /tmp/chrome.zip' | sha256sum -c - \
 && mkdir -p /opt/google \
 && unzip -q /tmp/chrome.zip -d /opt/google \
 && mv /opt/google/chrome-linux64 /opt/google/chrome \
 && rm /tmp/chrome.zip

COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
USER node
COPY --chown=node:node package.json package-lock.json .npmrc ./
COPY --chown=node:node apps/farm/package.json apps/farm/package.json
COPY --chown=node:node packages/connector/package.json packages/connector/package.json
COPY --chown=node:node packages/farm-protocol/package.json packages/farm-protocol/package.json
COPY --chown=node:node packages/shared/package.json packages/shared/package.json
COPY --chown=node:node packages/sim-cams/package.json packages/sim-cams/package.json
COPY --chown=node:node packages/sim-tools/package.json packages/sim-tools/package.json
COPY --chown=node:node packages/webrtc-experiment/package.json packages/webrtc-experiment/package.json
RUN npm ci --ignore-scripts && npm cache clean --force
COPY --chown=node:node . .
# Non-root so permission-based refusals (e.g. mode 0500 directories) match the host suite.
# The Node suite uses git ls-files. Index the source snapshot as the runtime user.
RUN git init --quiet && git add --all
CMD ["npm", "run", "check:all"]
