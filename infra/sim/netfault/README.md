# Network fault harness

Opt-in WebRTC reachability checks for issue #2: NAT, latency/loss (netem) and
UDP-block. Results and their meaning for the product are in
[SIMULATOR-NETWORK-FAULTS-CHECKPOINT.md](../../../docs/SIMULATOR-NETWORK-FAULTS-CHECKPOINT.md).

```sh
pnpm install --frozen-lockfile --ignore-scripts
infra/sim/netfault/run.sh nat 3 /path/to/evidence
infra/sim/netfault/run.sh netem 3 /path/to/evidence
infra/sim/netfault/run.sh udp-block 3 /path/to/evidence
```

`NETFAULT_PROJECT` (default `o3dfm-netfault`) names the Compose project. The
script refuses a project that already has containers, starts the topology fresh
for every probe and removes its containers, networks and temporary files on exit.

## Topology

| Container   | Network               | Capabilities           | Role                                                       |
| ----------- | --------------------- | ---------------------- | ---------------------------------------------------------- |
| `browser`   | wan `10.231.31.20`    | none                   | Answering peer and HTTP offer endpoint (TCP signalling)    |
| `router`    | lan `.2`, wan `.2`    | `NET_ADMIN`, `NET_RAW` | NAT (masquerade) lan → wan; applies netem / UDP drop       |
| `lan-gw`    | lan `10.231.32.10`    | `NET_ADMIN`            | Holds the lan namespace; sets its default route via router |
| `connector` | shares `lan-gw` netns | none                   | Offering peer with the Connector's PeerConnection options  |

`NET_ADMIN` is granted only to `router` and `lan-gw`, and only inside their own
network namespaces. Nothing changes host networking or touches other
containers. wan is an internal network. lan is a normal bridge with IP
masquerade disabled: Docker's internal-network rules drop routed frames, and the
isolated gateway mode is allowed only for internal networks. The lan probes route
only via the router, whose `FORWARD` policy drops everything except lan → wan and
established replies. The probes run as UID 1000 with a read-only root, no
capabilities and the repository mounted read-only. `node-datachannel` is copied
(dereferenced) into a temporary directory and mounted read-only, because pnpm may
keep it in a store outside the checkout.

Faults are applied with `iptables` and `tc` inside the router:

- `nat`: masquerade only.
- `netem`: `delay 100ms 10ms loss 5%` on both router interfaces (about 200 ms
  added round trip, 5 % loss each way).
- `udp-block`: `iptables -I FORWARD -p udp -j DROP`. TCP signalling still passes.

The probe uses the Connector's ICE configuration (no STUN/TURN, no ICE-TCP,
fingerprint verification on) and runs twice per repeat: with the Connector's
`bindAddress: '127.0.0.1'` policy, and bound to all interfaces.
