#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/open3d-local-ci-test.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
cat > "$scratch/bin/bun" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == --version ]]; then printf '%s\n' 1.4.2; exit 0; fi
printf '%s\n' "$*" >> "$TMPDIR/calls"
exit 42
EOF
cat > "$scratch/bin/node" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == --version ]]; then printf '%s\n' v24.20.0; exit 0; fi
exit 99
EOF
cat > "$scratch/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMPDIR/docker-calls"
if [[ $1 == info && ${2:-} == --format ]]; then printf '%s\n' aarch64; exit 0; fi
if [[ ( $1 == image || $1 == container ) && ${2:-} == inspect ]]; then exit 1; fi
exit 0
EOF
chmod +x "$scratch/bin/bun" "$scratch/bin/node" "$scratch/bin/docker"
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
expect_status 42 code
[[ $(cat "$scratch/calls") == 'install --frozen-lockfile --ignore-scripts' ]]
if grep -q 'Selected local job(s) passed' "$scratch/output"; then exit 1; fi
ledger=$(sed -n 's/^Evidence ledger: //p' "$scratch/output")
[[ $ledger == "$scratch"/open3d-local-ci.* && -f $ledger/disk-before.txt && -f $ledger/disk-after.txt ]]
printf '%s\n' 'Local CI argument, opt-in, failure propagation and cleanup ledger checks passed.'
