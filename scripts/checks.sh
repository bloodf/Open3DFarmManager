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

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 2
case ${ORQ_CHANGED_FILES-} in
  '' | /*) ;;
  *) ORQ_CHANGED_FILES=$PWD/$ORQ_CHANGED_FILES ;;
esac
case ${ORQ_DELETED_FILES-} in
  '' | /*) ;;
  *) ORQ_DELETED_FILES=$PWD/$ORQ_DELETED_FILES ;;
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
  changed=
  deleted=
  full=0
  unknown_base=0
  if git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    known_base=1
  else
    known_base=0
  fi
  if [ "${ORQ_CHANGED_FILES+x}" = x ]; then
    changed=$(cat -- "$ORQ_CHANGED_FILES") || exit 2
  elif [ "$known_base" = 1 ]; then
    changed=$(git -c core.quotePath=false diff --no-renames --name-only --diff-filter=d "$base" HEAD) || exit 2
  else
    echo "checks: unknown base: $base; running the full unit suite" >&2
    unknown_base=1
    full=1
  fi
  if [ "${ORQ_DELETED_FILES+x}" = x ]; then
    deleted=$(cat -- "$ORQ_DELETED_FILES") || exit 2
  elif [ "$known_base" = 1 ]; then
    deleted=$(git -c core.quotePath=false diff --no-renames --name-only --diff-filter=D "$base" HEAD) || exit 2
  fi
  [ -z "$deleted" ] || full=1
  setup_env

  present=
  styles=
  code=
  typed=0
  go=0
  migrations=0
  for file in $changed $deleted; do
    case $file in
      infra/db/migrations/*) migrations=1 ;;
    esac
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

  node_tests=
  vitest_tests=
  if [ "$full" = 0 ] && [ -n "$present" ]; then
    if affected=$(node "$script_dir/checks-affected.mjs" $present); then
      for entry in $affected; do
        case $entry in
          node:*) node_tests=$(add "${entry#node:}" "$node_tests") ;;
          vitest:*) vitest_tests=$(add "${entry#vitest:}" "$vitest_tests") ;;
        esac
      done
    else
      echo 'checks: affected test selection failed; running the full unit suite' >&2
      full=1
    fi
  fi

  if [ -n "$present" ]; then
    step prettier npx prettier --check --ignore-unknown -- $present
  fi
  if [ -n "$styles" ]; then
    step hex-colours node apps/farm/app/assets/lint-hex-colours.mjs $styles
  fi
  if [ "$unknown_base" = 1 ]; then
    step lint npm run lint
  fi
  if [ "$full" = 1 ]; then
    step typecheck npm run typecheck
    step vitest npx vitest run --maxWorkers=50%
    step test:node npm run test:node
  else
    if [ "$typed" = 1 ]; then
      step typecheck npm run typecheck
    fi
    if [ -n "$code" ]; then
      step vitest npx vitest related --run --maxWorkers=50% --passWithNoTests $code
    fi
    if [ -n "$vitest_tests" ]; then
      step vitest-data npx vitest run --maxWorkers=50% $vitest_tests
    fi
    if [ -n "$node_tests" ]; then
      # Same flags as `npm run test:node`.
      step node-tests node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit $node_tests
    fi
  fi
  if [ "$migrations" = 1 ] || [ "$unknown_base" = 1 ]; then
    if [ -f scripts/test-postgres.ts ]; then
      step test:postgres npm run test:postgres
    fi
  fi
  if [ "$go" = 1 ] || [ "$unknown_base" = 1 ]; then
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
