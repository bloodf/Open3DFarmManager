#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' 'Usage: bash scripts/local-ci.sh {code|image|klipper|all} [--containers] [--simulator] [--allow-emulation]'
}
if (($# < 1)); then usage >&2; exit 2; fi
job=$1
shift
case "$job" in code|image|klipper|all) ;; *) usage >&2; exit 2 ;; esac
containers=0 simulator=0 emulation=0
for argument in "$@"; do
  case "$argument" in
    --containers) containers=1 ;;
    --simulator) simulator=1 ;;
    --allow-emulation) emulation=1 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [[ $job != code && $containers != 1 ]]; then
  printf '%s\n' 'UNSUPPORTED: image and simulator jobs require --containers.' >&2; exit 2
fi
if [[ $job == klipper || $job == all ]]; then
  if [[ $simulator != 1 ]]; then
    printf '%s\n' 'UNSUPPORTED: Klipper creates two isolated emulators; pass --simulator.' >&2; exit 2
  fi
fi
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
ledger=$(mktemp -d "${TMPDIR:-/tmp}/open3d-local-ci.XXXXXXXX")
printf 'Evidence ledger: %s\n' "$ledger"
printf 'job=%s\ncontainers=%s\nsimulator=%s\nemulation=%s\n' "$job" "$containers" "$simulator" "$emulation" > "$ledger/task.txt"
df -Pk . > "$ledger/disk-before.txt"
git status --short > "$ledger/git-before.txt"
git worktree list > "$ledger/worktrees-before.txt"
for path in apps/farm/.nuxt apps/farm/.output packages/connector/dist node_modules; do
  if [[ -e $path ]]; then printf 'pre-existing %s\n' "$path"; else printf 'absent %s\n' "$path"; fi
done > "$ledger/output-baseline.txt"
image_tag="open3dfarmmanager-local-ci:$(basename "$ledger" | tr '[:upper:].' '[:lower:]-')"
container_name="$(basename "$ledger" | tr '[:upper:].' '[:lower:]-')-image"
project_name="$(basename "$ledger" | tr '[:upper:].' '[:lower:]-')-sim"
sim_image='ghcr.io/mainsail-crew/virtual-klipper-printer@sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47'
image_created=0 image_container=0 sim_started=0 sim_image_preexisting=1 cleanup_failed=0
printf 'image_tag=%s\ncontainer=%s\ncompose_project=%s\nsimulator_image=%s\n' "$image_tag" "$container_name" "$project_name" "$sim_image" >> "$ledger/task.txt"
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if ((sim_started)); then
    docker ps -a --no-trunc --filter "label=com.docker.compose.project=$project_name" > "$ledger/simulator-containers.txt" || cleanup_failed=1
    docker volume ls --filter "label=com.docker.compose.project=$project_name" > "$ledger/simulator-volumes.txt" || cleanup_failed=1
    docker network ls --no-trunc --filter "label=com.docker.compose.project=$project_name" > "$ledger/simulator-networks.txt" || cleanup_failed=1
    docker image inspect "$sim_image" > "$ledger/simulator-image.json" 2>/dev/null || true
    docker compose -p "$project_name" -f infra/sim/docker-compose.yml --profile klipper down --volumes --remove-orphans >> "$ledger/cleanup.log" 2>&1 || cleanup_failed=1
  fi
  if ((image_container)) && docker container inspect "$container_name" >/dev/null 2>&1; then docker rm -f "$container_name" >> "$ledger/cleanup.log" 2>&1 || cleanup_failed=1; fi
  if ((image_created)) && docker image inspect "$image_tag" >/dev/null 2>&1; then docker image rm "$image_tag" >> "$ledger/cleanup.log" 2>&1 || cleanup_failed=1; fi
  if ((sim_started && !sim_image_preexisting)) && docker image inspect "$sim_image" >/dev/null 2>&1; then
    if [[ -z $(docker ps -aq --filter "ancestor=$sim_image") ]]; then
      docker image rm "$sim_image" >> "$ledger/cleanup.log" 2>&1 || cleanup_failed=1
    else printf '%s\n' 'Retained simulator image: another container references it.' >> "$ledger/cleanup.log"; fi
  fi
  df -Pk . > "$ledger/disk-after.txt" || cleanup_failed=1
  if ((containers)); then
    docker ps -a --no-trunc > "$ledger/containers-after.txt" || cleanup_failed=1
    docker images --digests --no-trunc > "$ledger/images-after.txt" || cleanup_failed=1
    docker volume ls > "$ledger/volumes-after.txt" || cleanup_failed=1
    docker network ls > "$ledger/networks-after.txt" || cleanup_failed=1
    docker system df > "$ledger/docker-space-after.txt" || cleanup_failed=1
  fi
  printf '%s\n' 'Shared build outputs and dependency/cache state are retained; compare output-baseline.txt before any cleanup.' >> "$ledger/cleanup.log"
  if ((cleanup_failed)); then printf '%s\n' 'Cleanup incomplete; inspect the ledger.' >&2; ((result == 0)) && result=1; fi
  printf 'Local CI exit=%s; ledger=%s\n' "$result" "$ledger"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ((containers)); then
  command -v docker >/dev/null || { printf '%s\n' 'UNSUPPORTED: Docker is unavailable.' >&2; exit 2; }
  docker info >/dev/null
  docker ps -a --no-trunc > "$ledger/containers-before.txt"
  docker images --digests --no-trunc > "$ledger/images-before.txt"
  docker volume ls > "$ledger/volumes-before.txt"
  docker network ls > "$ledger/networks-before.txt"
  docker system df > "$ledger/docker-space-before.txt"
  arch=$(docker info --format '{{.Architecture}}')
  printf 'docker_arch=%s\n' "$arch" >> "$ledger/task.txt"
  if [[ $arch != x86_64 && $arch != amd64 && $emulation != 1 ]]; then
    printf '%s\n' 'UNSUPPORTED: workflows use linux/amd64; pass --allow-emulation for a non-equivalent emulated run.' >&2; exit 2
  fi
  available=$(df -Pk . | awk 'NR==2 {print $4}')
  if ((available < 10485760)); then printf '%s\n' 'Insufficient free disk for container jobs (10 GiB minimum).'; exit 2; fi
fi
code_job() {
  if ! command -v bun >/dev/null || ! command -v node >/dev/null; then
    printf '%s\n' 'UNSUPPORTED: Bun and Node are required.' >&2; return 2
  fi
  [[ $(bun --version) == 1.4.4 && $(node --version) == v24.22.2 ]] || { printf '%s\n' 'UNSUPPORTED: workflow requires Bun 1.4.4 and Node 24.22.2.' >&2; return 2; }
  [[ -d node_modules ]] || { printf '%s\n' 'UNSUPPORTED: install workspace dependencies before running local CI.' >&2; return 2; }
  bun install --frozen-lockfile --ignore-scripts
  bun run lint
  bun run check:all
  node packages/connector/dist/cli.js --version
  # Browser and OS libraries must already be installed; never install system packages implicitly.
  bun run test:e2e
}
image_job() {
  if docker image inspect "$image_tag" >/dev/null 2>&1 || docker container inspect "$container_name" >/dev/null 2>&1; then
    printf '%s\n' 'Resource name collision; refusing to use pre-existing image or container.' >&2
    return 2
  fi
  for base in oven/bun:1.4.4 node:24.22.2-alpine; do
    local platform
    platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$base" 2>/dev/null || true)
    if [[ $platform == / ]]; then
      platform=$(docker image inspect --platform linux/amd64 --format '{{.Os}}/{{.Architecture}}' "$base" 2>/dev/null || true)
    fi
    if [[ $platform != linux/amd64 ]]; then
      printf 'UNSUPPORTED: preinstall linux/amd64 base image %s; this runner does not pull shared build bases.\n' "$base" >&2
      return 2
    fi
  done
  image_created=1
  docker build --platform linux/amd64 -f apps/farm/Dockerfile -t "$image_tag" .
  docker image inspect "$image_tag" > "$ledger/built-image.json"
  image_container=1
  docker run -d --name "$container_name" --read-only --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1::3000 "$image_tag"
  docker inspect "$container_name" > "$ledger/image-container.json"
  local port
  port=$(docker port "$container_name" 3000/tcp | sed -n 's/^127\.0\.0\.1://p')
  [[ $port =~ ^[0-9]+$ ]] || { printf '%s\n' 'Missing loopback port' >&2; return 1; }
  for ((attempt=0; attempt<30; attempt++)); do
    if curl --fail --silent --max-time 1 "http://127.0.0.1:$port/healthz"; then
      docker rm -f "$container_name"
      image_container=0
      docker image rm "$image_tag"
      image_created=0
      return 0
    fi
    sleep 1
  done
  docker logs --tail 150 "$container_name" > "$ledger/image-failure.log" 2>&1 || true
  return 1
}
klipper_job() {
  if ! command -v bun >/dev/null || ! command -v node >/dev/null; then
    printf '%s\n' 'UNSUPPORTED: Bun and Node are required.' >&2; return 2
  fi
  [[ $(bun --version) == 1.4.4 && -d node_modules ]] || { printf '%s\n' 'UNSUPPORTED: Bun 1.4.4 and existing workspace dependencies are required.' >&2; return 2; }
  if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$project_name") ||
        -n $(docker volume ls -q --filter "label=com.docker.compose.project=$project_name") ||
        -n $(docker network ls -q --filter "label=com.docker.compose.project=$project_name") ]]; then
    printf '%s\n' 'Compose project name collision; refusing to use pre-existing resources.' >&2
    return 2
  fi
  local running_images running_pinned=''
  running_images=$(docker ps --format '{{.Image}}')
  if docker image inspect "$sim_image" >/dev/null 2>&1; then
    running_pinned=$(docker ps -q --filter "ancestor=$sim_image")
  fi
  if [[ -n $running_pinned ]] || grep -q 'virtual-klipper-printer' <<< "$running_images"; then
    printf '%s\n' 'UNSUPPORTED: another simulator is running; coordinate ownership first.' >&2
    return 2
  fi
  if ! docker image inspect "$sim_image" >/dev/null 2>&1; then sim_image_preexisting=0; fi
  bun install --frozen-lockfile --ignore-scripts
  docker compose -p "$project_name" -f infra/sim/docker-compose.yml --profile klipper config --quiet
  sim_started=1
  local failure
  if docker compose -p "$project_name" -f infra/sim/docker-compose.yml --profile klipper up -d; then :; else
    failure=$?
    node scripts/klipper-diagnostics.mjs "$project_name" > "$ledger/simulator-failure.log" 2>&1 || true
    return "$failure"
  fi
  if env -u SIM_SV06_URL -u SIM_U1_URL bun run sim:smoke; then :; else
    failure=$?
    node scripts/klipper-diagnostics.mjs "$project_name" > "$ledger/simulator-failure.log" 2>&1 || true
    return "$failure"
  fi
}
case "$job" in
  code) code_job ;;
  image) image_job ;;
  klipper) klipper_job ;;
  all) code_job; image_job; klipper_job ;;
esac
printf '%s\n' 'Selected local job(s) passed. GitHub checks remain required.'
