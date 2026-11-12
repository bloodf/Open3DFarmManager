#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Network fault harness (issue #2). Usage:
#   infra/sim/netfault/run.sh <nat|netem|udp-block> [repeats] [out-dir]
# Each repeat starts the topology fresh, applies the fault inside the router's
# namespace, runs the Connector-side probe with the Connector's loopback bind
# policy and with an all-interfaces bind, then removes every resource it made.
set -euo pipefail
scenario=${1:-}
repeats=${2:-3}
out=${3:-$(mktemp -d "${TMPDIR:-/tmp}/o3dfm-netfault.XXXXXX")}
case "$scenario" in nat | netem | udp-block) ;; *)
  echo 'Usage: run.sh <nat|netem|udp-block> [repeats] [out-dir]' >&2
  exit 2
  ;;
esac
[[ $repeats =~ ^[1-9][0-9]?$ ]] || { echo 'repeats must be 1-99' >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
project=${NETFAULT_PROJECT:-o3dfm-netfault}
[[ $project =~ ^o3dfm-[a-z0-9-]{1,40}$ ]] || { echo 'invalid NETFAULT_PROJECT' >&2; exit 2; }
dc() { docker compose -p "$project" -f "$here/docker-compose.yml" "$@"; }
mkdir -p "$out"
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]]; then
  echo "Compose project $project already has containers; refusing to reuse them." >&2
  exit 2
fi
# node-datachannel and its native prebuild may live in a global pnpm store outside
# the checkout; copy just that package closure (dereferenced) for a read-only mount.
NETFAULT_NDC=$(mktemp -d "${TMPDIR:-/tmp}/o3dfm-netfault-ndc.XXXXXX")
export NETFAULT_NDC
ndc=$(realpath "$here/../../../packages/connector/node_modules/node-datachannel")
mkdir -p "$NETFAULT_NDC/node_modules"
cp -rL "$(dirname "$ndc")/." "$NETFAULT_NDC/node_modules/"
printf '{"private":true}\n' > "$NETFAULT_NDC/package.json"
chmod -R a+rX "$NETFAULT_NDC"
cleanup() { dc --profile probe down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap 'cleanup; rm -rf "$NETFAULT_NDC"' EXIT

router() { dc exec -T router sh -euc "$1"; }
apply_fault() {
  # Interfaces are found by the fixed addresses from docker-compose.yml.
  router '
    lan=$(ip -o -4 addr show | awk "/10\.231\.32\.2\//{print \$2}")
    wan=$(ip -o -4 addr show | awk "/10\.231\.31\.2\//{print \$2}")
    iptables -t nat -A POSTROUTING -s 10.231.32.0/24 -o "$wan" -j MASQUERADE
    iptables -A FORWARD -i "$lan" -o "$wan" -j ACCEPT
    iptables -A FORWARD -i "$wan" -o "$lan" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -P FORWARD DROP
    case '"$scenario"' in
      netem)
        tc qdisc add dev "$wan" root netem delay 100ms 10ms loss 5%
        tc qdisc add dev "$lan" root netem delay 100ms 10ms loss 5% ;;
      udp-block)
        iptables -I FORWARD -p udp -j DROP ;;
    esac'
}

for run in $(seq 1 "$repeats"); do
  for bind in loopback any; do
    cleanup
    dc up -d --build --wait router lan-gw browser >/dev/null
    apply_fault
    result=$(dc --profile probe run --rm -T -e PROBE_BIND="$bind" connector | tail -1)
    browser=$(dc logs --no-log-prefix browser | grep '"event":"channel"' | tail -1 || true)
    printf '{"scenario":"%s","run":%s,"connector":%s,"browser":%s}\n' \
      "$scenario" "$run" "$result" "${browser:-null}" | tee -a "$out/$scenario.jsonl"
  done
done
echo "results: $out/$scenario.jsonl"
