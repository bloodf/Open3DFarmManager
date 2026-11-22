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
# Subnets 10.<octet>.31.0/24 (wan) and 10.<octet>.32.0/24 (lan). Concurrent
# projects on one host need distinct octets; Docker rejects overlapping pools.
NETFAULT_OCTET=${NETFAULT_OCTET:-231}
[[ $NETFAULT_OCTET =~ ^[0-9]{1,3}$ ]] && ((NETFAULT_OCTET >= 1 && NETFAULT_OCTET <= 254)) || {
  echo 'NETFAULT_OCTET must be 1-254' >&2
  exit 2
}
export NETFAULT_OCTET
project=${NETFAULT_PROJECT:-o3dfm-netfault-$(date +%s)-$$}
export NETFAULT_PROJECT=$project
[[ $project =~ ^o3dfm-[a-z0-9-]{1,40}$ ]] || { echo 'invalid NETFAULT_PROJECT' >&2; exit 2; }
dc() { docker compose -p "$project" -f "$here/docker-compose.json" "$@"; }
mkdir -p "$out"
# Refuse every pre-existing project resource, including stopped containers.
for kind in container network volume; do
  if [[ -n $(docker "$kind" ls -q --filter "label=com.docker.compose.project=$project") ]]; then
    echo "Project $project already owns $kind resources; refusing reuse" >&2
    exit 2
  fi
done
if docker image inspect "$project-router" >/dev/null 2>&1; then
  echo 'Router image already exists; refusing reuse' >&2
  exit 2
fi
NETFAULT_NDC=$(mktemp -d "${TMPDIR:-/tmp}/o3dfm-netfault-ndc.XXXXXX")
export NETFAULT_NDC
cleanup() {
  # Verify labels before Compose is allowed to delete anything.
  for kind in container network volume; do
    while read -r resource; do
      [[ -z $resource ]] && continue
      owner=$(docker "$kind" inspect --format '{{ index .Labels "org.open3dfarmmanager.netfault" }}' "$resource" 2>/dev/null) || {
        [[ $kind == container ]] || return 1
        owner=$(docker inspect --format '{{ index .Config.Labels "org.open3dfarmmanager.netfault" }}' "$resource")
      }
      [[ $owner == "$project" ]] || { echo "Foreign resource $resource; refusing cleanup" >&2; return 1; }
    done < <(docker "$kind" ls -q --filter "label=com.docker.compose.project=$project")
  done
  dc --profile "$scenario" down --volumes
}
finish() {
  status=$?
  if ((status != 0)); then
    dc logs --no-color browser 2>&1 | tee "$out/$scenario-browser.log" >&2 || true
  fi
  cleanup || status=1
  if docker image inspect "$project-router" >/dev/null 2>&1; then
    docker image rm "$project-router" >/dev/null || status=1
  fi
  rm -rf "$NETFAULT_NDC"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
modules=$(realpath "$here/../../../node_modules")
mkdir -p "$NETFAULT_NDC/node_modules/@node-datachannel"
# The probes use the pinned linux/amd64 glibc image. Ship the matching native
# addon from npm's optional dependencies alongside the JS wrapper.
cp -rL "$modules/node-datachannel" "$modules/detect-libc" "$NETFAULT_NDC/node_modules/"
cp -rL "$modules/@node-datachannel/linux-x64-gnu" "$NETFAULT_NDC/node_modules/@node-datachannel/"
printf '{"private":true}\n' > "$NETFAULT_NDC/package.json"
chmod -R a+rX "$NETFAULT_NDC"
router() { dc exec -T -e O="$NETFAULT_OCTET" router sh -euc "$1"; }
apply_fault() {
  # Interfaces are found by the fixed addresses from docker-compose.json.
  router '
    lan=$(ip -o -4 addr show | awk "/10\.$O\.32\.2\//{print \$2}")
    wan=$(ip -o -4 addr show | awk "/10\.$O\.31\.2\//{print \$2}")
    iptables -A OUTPUT -d "10.$O.32.1" -j DROP
    iptables -t nat -A POSTROUTING -s "10.$O.32.0/24" -o "$wan" -j MASQUERADE
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
    # The lan namespace must not reach the host gateway on the lan bridge.
    dc exec -T lan-gw iptables -C OUTPUT -d "10.$NETFAULT_OCTET.32.1" -j DROP
    result=$(dc --profile "$scenario" run --rm -T -e PROBE_BIND="$bind" connector | tail -1)
    # A crashed probe prints a stack trace, not a JSON object.
    [[ $result == '{'* ]] || { echo 'Probe produced no JSON' >&2; exit 1; }
      RESULT="$result" SCENARIO="$scenario" BIND="$bind" node "$here/validate-result.mjs"
    browser=$(dc logs --no-log-prefix browser | grep '"event":"channel"' | tail -1 || true)
    printf '{"scenario":"%s","run":%s,"connector":%s,"browser":%s}\n' \
      "$scenario" "$run" "$result" "${browser:-null}" | tee -a "$out/$scenario.jsonl"
  done
done
echo "results: $out/$scenario.jsonl"
