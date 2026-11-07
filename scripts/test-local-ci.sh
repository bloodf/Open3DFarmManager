#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/open3d-local-ci-test.XXXXXXXX")
fake_modules=0
if [[ ! -d "$root/node_modules" ]]; then
  if mkdir "$root/node_modules"; then fake_modules=1; fi
fi
cleanup() {
  local result=$?
  rm -rf "$scratch"
  if ((fake_modules)); then
    if ! rmdir "$root/node_modules" 2>/dev/null; then
      printf '%s\n' 'Retained node_modules: fixture is no longer an empty directory; no recursive cleanup attempted.' >&2
    fi
  fi
  return "$result"
}
trap cleanup EXIT
mkdir "$scratch/bin"
export LOCAL_CI_REAL_NODE
LOCAL_CI_REAL_NODE=$(command -v node)
pins=$("$LOCAL_CI_REAL_NODE" --input-type=module - "$root" <<'EOF'
import { readFileSync } from 'node:fs';
const root = process.argv[2];
const read = path => readFileSync(`${root}/${path}`, 'utf8');
const workflow = read('.github/workflows/ci.yml');
const one = (pattern, text, label) => {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Expected one exact ${label} pin`);
  return matches[0][1];
};
const pnpm = one(/^          version: '([0-9]+\.[0-9]+\.[0-9]+)'$/gm, workflow, 'workflow pnpm');
const node = one(/^          node-version: '([0-9]+\.[0-9]+\.[0-9]+)'$/gm, workflow, 'workflow Node');
const manager = JSON.parse(read('package.json')).packageManager;
if (manager !== `pnpm@${pnpm}` || read('.nvmrc').trim() !== node) {
  throw new Error('Workflow pins disagree with packageManager or .nvmrc');
}
console.log(pnpm, node);
EOF
)
read -r LOCAL_CI_PIN_PNPM LOCAL_CI_PIN_NODE <<< "$pins"
export LOCAL_CI_PIN_PNPM LOCAL_CI_PIN_NODE
cat > "$scratch/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == --version ]]; then printf '%s\n' "$LOCAL_CI_PIN_PNPM"; exit 0; fi
printf '%s\n' "$*" >> "$TMPDIR/calls"
if [[ ${LOCAL_CI_FAKE_SIM:-0} == 1 && ${1:-} == install ]]; then exit 0; fi
exit 42
EOF
cat > "$scratch/bin/node" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == --version ]]; then printf 'v%s\n' "$LOCAL_CI_PIN_NODE"; exit 0; fi
exec "$LOCAL_CI_REAL_NODE" "$@"
EOF
cat > "$scratch/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMPDIR/docker-calls"
if [[ $1 == info && ${2:-} == --format ]]; then
  if [[ ${LOCAL_CI_FAKE_SIM:-0} == 1 ]]; then printf '%s\n' x86_64; else printf '%s\n' aarch64; fi
  exit 0
fi
if [[ -n ${LOCAL_CI_FAKE_BASE:-} && $1 == image && ${2:-} == inspect && ${*: -1} == "node:${LOCAL_CI_PIN_NODE}-alpine" ]]; then
  if [[ ${3:-} == --platform ]]; then
    case "$LOCAL_CI_FAKE_BASE" in
      index) printf '%s\n' linux/amd64 ;;
      explicit-error) exit 1 ;;
      explicit-empty) exit 0 ;;
      explicit-mismatch) printf '%s\n' linux/arm64 ;;
    esac
  else
    case "$LOCAL_CI_FAKE_BASE" in
      direct) printf '%s\n' linux/amd64 ;;
      default-mismatch) printf '%s\n' linux/arm64 ;;
      default-empty) exit 0 ;;
      *) printf '%s\n' / ;;
    esac
  fi
  exit 0
fi
if [[ -n ${LOCAL_CI_FAKE_BASE:-} && $1 == build ]]; then exit 43; fi
if [[ ${LOCAL_CI_FAKE_SIM:-0} == 1 ]]; then
  case "$*" in
    *'ps -aq sv06'*) printf '%s\n' aaaaaaaaaaaa ;;
    *'ps -aq u1'*) printf '%s\n' bbbbbbbbbbbb ;;
    *'tail -c'*) printf '%s\n' 'MCU shutdown: Timer too close SECRET_MARKER' ;;
    'inspect --format'*) printf '%s\n' 'running 0 false' ;;
  esac
fi
if [[ ( $1 == image || $1 == container ) && ${2:-} == inspect ]]; then exit 1; fi
exit 0
EOF
chmod +x "$scratch/bin/pnpm" "$scratch/bin/node" "$scratch/bin/docker"
expect_status() {
  local expected=$1 actual
  shift
  actual=0
  PATH="$scratch/bin:$PATH" TMPDIR="$scratch" bash "$root/scripts/local-ci.sh" "$@" > "$scratch/output" 2>&1 || actual=$?
  [[ $actual == "$expected" ]] || { cat "$scratch/output"; printf 'Expected %s, got %s\n' "$expected" "$actual" >&2; exit 1; }
}
expect_status 2 invalid
expect_status 2 all
expect_status 2 klipper --containers
expect_status 2 code --unknown
expect_status 2 image --containers
grep -q 'pass --allow-emulation' "$scratch/output"
expect_status 2 image --containers --allow-emulation
grep -q 'preinstall linux/amd64 base image' "$scratch/output"
if grep -q '^build ' "$scratch/docker-calls"; then exit 1; fi
for mode in direct index; do
  : > "$scratch/docker-calls"
  export LOCAL_CI_FAKE_BASE=$mode
  expect_status 43 image --containers --allow-emulation
  grep -q '^build --platform linux/amd64 ' "$scratch/docker-calls"
  if [[ $mode == index ]]; then
    [[ $(grep -c '^image inspect --platform linux/amd64 ' "$scratch/docker-calls") == 1 ]]
  elif grep -q '^image inspect --platform ' "$scratch/docker-calls"; then exit 1; fi
done
for mode in explicit-error explicit-empty explicit-mismatch default-mismatch default-empty; do
  : > "$scratch/docker-calls"
  export LOCAL_CI_FAKE_BASE=$mode
  expect_status 2 image --containers --allow-emulation
  if grep -q '^build ' "$scratch/docker-calls"; then exit 1; fi
done
unset LOCAL_CI_FAKE_BASE
expect_status 42 code
[[ $(cat "$scratch/calls") == 'install --frozen-lockfile --ignore-scripts' ]]
if grep -q 'Selected local job(s) passed' "$scratch/output"; then exit 1; fi
ledger=$(sed -n 's/^Evidence ledger: //p' "$scratch/output")
[[ $ledger == "$scratch"/open3d-local-ci.* && -f $ledger/disk-before.txt && -f $ledger/disk-after.txt ]]
export LOCAL_CI_FAKE_SIM=1
expect_status 42 klipper --containers --simulator
ledger=$(sed -n 's/^Evidence ledger: //p' "$scratch/output")
[[ -f $ledger/simulator-failure.log ]]
grep -q '"timer-too-close":1' "$ledger/simulator-failure.log"
if grep -q SECRET_MARKER "$ledger/simulator-failure.log"; then exit 1; fi
grep -q 'down --volumes --remove-orphans' "$scratch/docker-calls"
printf '%s\n' 'Local CI argument, opt-in, failure propagation and cleanup ledger checks passed.'
