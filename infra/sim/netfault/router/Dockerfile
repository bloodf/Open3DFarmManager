# SPDX-License-Identifier: MIT
# Test-only NAT router for the network fault harness. Holds NET_ADMIN inside its
# own network namespace only; it never touches host networking.
FROM alpine@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache iptables=1.8.13-r0 iproute2=7.0.0-r0 iproute2-tc=7.0.0-r0
CMD ["sleep", "infinity"]
