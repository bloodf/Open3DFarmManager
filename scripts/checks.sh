#!/bin/sh
# Repository checks. Every step runs; failures are summarised at the end.
#   sh scripts/checks.sh unit [base]        only what base..HEAD touched
#   sh scripts/checks.sh final              full suite plus Playwright
#   sh scripts/checks.sh plan unit [base]   print the commands, run nothing
#   sh scripts/checks.sh plan final
set -u

usage() {
  echo 'usage: sh scripts/checks.sh [plan] unit [base] | [plan] final' >&2
  exit 2
}

plan=0
if [ "${1:-}" = plan ]; then
  plan=1
  shift
fi
mode=${1:-}
case $mode in
  unit | final) ;;
  *) usage ;;
esac

root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2

# File lists are newline separated; names such as [id].vue must not be globbed.
nl='
'
IFS=$nl
set -f

failed=
step() {
  name=$1
  shift
  if [ "$plan" = 1 ]; then
    (IFS=' ' && printf '%s\n' "$*")
    return
  fi
  printf '\n== %s ==\n' "$name"
  "$@" || failed="$failed$name$nl"
}

add() {
  case "$nl$2$nl" in
    *"$nl$1$nl"*) printf '%s' "$2" ;;
    *) printf '%s' "${2:+$2$nl}$1" ;;
  esac
}

setup_env() {
  [ "$plan" = 1 ] && return
  run_tmp=${XDG_CACHE_HOME:-$HOME/.cache}/openfarm-checks/$$
  mkdir -p "$run_tmp" || exit 1
  trap 'rm -rf "$run_tmp"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  export TMPDIR="$run_tmp"
  chrome_env=$HOME/.local/state/openfarm-farm/chrome/env.sh
  if [ -f "$chrome_env" ]; then
    . "$chrome_env"
  fi
}

unit() {
  base=${1:-${ORQ_BASE_SHA:-origin/main}}
  if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    echo "checks: unknown base: $base" >&2
    exit 2
  fi
  changed=$(git -c core.quotePath=false diff --name-only --diff-filter=d "$base" HEAD) || exit 2
  setup_env

  present=
  styles=
  code=
  typed=0
  go=0
  for file in $changed; do
    case $file in
      tools/rtsp-ingest/*.md) ;;
      tools/rtsp-ingest/*) go=1 ;;
    esac
    # Skip symlinks and files no longer in the working tree.
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    present=$(add "$file" "$present")
    case $file in
      apps/farm/app/components/* | apps/farm/app/assets/*)
        styles=$(add "$file" "$styles")
        ;;
    esac
    case $file in
      *.ts | *.vue | *.mts) typed=1 ;;
    esac
    case $file in
      *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs | *.vue)
        code=$(add "$file" "$code")
        ;;
    esac
  done

  # Node tests live outside Vitest: pick the changed ones and the importers.
  node_tests=
  extra_tests="tests/unit/pause-authority-tooling.test.ts${nl}tests/unit/pause-authority-timeout.test.ts${nl}tests/helpers/kobralink-rtc/cdp-body.test.ts"
  all_node_tests=$(git ls-files -- ':(glob)tests/node/*.test.ts')
  all_node_tests="$all_node_tests$nl$extra_tests"
  for file in $code; do
    for candidate in $all_node_tests; do
      if [ "$candidate" = "$file" ]; then
        node_tests=$(add "$candidate" "$node_tests")
      fi
    done

    # How a test under tests/<dir>/ spells this path.
    case $file in
      tests/node/*) relative=./${file#tests/node/} ;;
      tests/*) relative=../${file#tests/} ;;
      *) relative=../../$file ;;
    esac
    set -- -e "'$relative'" -e "\"$relative\"" -e "'$file'" -e "\"$file\""
    # Workspace packages are also imported by name.
    case $file in
      packages/*/src/*)
        package=${file#packages/}
        package=@open3dfarmmanager/${package%%/*}
        set -- "$@" -e "'$package'" -e "\"$package\""
        ;;
    esac
    for candidate in $all_node_tests; do
      if [ -f "$candidate" ] && grep -qF "$@" -- "$candidate"; then
        node_tests=$(add "$candidate" "$node_tests")
      fi
    done
    case $file in
      tests/helpers/kobralink-rtc/*)
        node_tests=$(add tests/helpers/kobralink-rtc/cdp-body.test.ts "$node_tests")
        ;;
    esac
  done

  # $present, $styles, $code and $node_tests split on newlines only.
  if [ -n "$present" ]; then
    step prettier npx prettier --check --ignore-unknown -- $present
  fi
  if [ -n "$styles" ]; then
    step hex-colours node apps/farm/app/assets/lint-hex-colours.mjs $styles
  fi
  if [ "$typed" = 1 ]; then
    step typecheck npm run typecheck
  fi
  if [ -n "$code" ]; then
    step vitest npx vitest related --run --maxWorkers=50% --passWithNoTests $code
  fi
  if [ -n "$node_tests" ]; then
    # Same flags as `npm run test:node`.
    step node-tests node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit $node_tests
  fi
  if [ "$go" = 1 ]; then
    step test:go npm run test:go
  fi
}

final() {
  setup_env
  step lint npm run lint
  step typecheck npm run typecheck
  step vitest npx vitest run --maxWorkers=50%
  step test:node npm run test:node
  step test:go npm run test:go
  step test:rtsp-supervisor npm run test:rtsp-supervisor
  step test:rtsp-framing npm run test:rtsp-framing
  step build npm run build
  step playwright npx playwright test --workers=2
}

shift
case $mode in
  unit) unit "${1:-}" ;;
  final) final ;;
esac

[ "$plan" = 1 ] && exit 0
if [ -n "$failed" ]; then
  printf '\nFailed steps:\n'
  printf '%s' "$failed"
  exit 1
fi
printf '\nAll %s checks passed.\n' "$mode"
