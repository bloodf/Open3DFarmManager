# SPDX-License-Identifier: MIT
# Test-only NAT router for the network fault harness. Holds NET_ADMIN inside its
# own network namespace only; it never touches host networking.
FROM alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
RUN apk add --no-cache iptables=1.8.13-r0 iproute2=7.0.0-r0 iproute2-tc=7.0.0-r0
CMD ["sleep", "infinity"]
