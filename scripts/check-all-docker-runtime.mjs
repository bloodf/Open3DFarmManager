// SPDX-License-Identifier: MIT
// Runtime prerequisites for the Docker-only `check:all` gate, besides the
// browser (see check-all-docker-browser.mjs).
//
// python3. The container's userland is the PostgreSQL image's Debian, which
// has no Python. The Node 22 image's Ubuntu python3 is reachable through the
// read-only /opt/gate-tools (= Node image /usr) mount and finds its stdlib from
// its own prefix, but its extension modules link libraries Debian lacks
// (pyexpat needs libexpat.so.1). A wrapper on PATH adds only those missing
// libraries, symlinked from the read-only Node image mount; libraries the
// container already provides (glibc, libssl, zlib, ...) are never shadowed.
//
// Scratch space. /tmp is an anonymous Docker volume rather than a tmpfs: it
// lives on the Docker host disk, so suites that require real free space (the
// release rehearsal asserts > 10 GiB under TMPDIR) see an honestly sized
// filesystem without spending container memory. An anonymous volume has no
// name to share or reuse; it belongs to the task container alone and is
// deleted with it by `docker rm -f -v`.
//
// Everything generated lives on that /tmp volume and disappears with it.

const PYTHON_DIR = '/tmp/gate-python'
/** Generated python3 wrapper directory; placed before /opt/gate-tools/bin. */
export const PYTHON_BIN_DIR = `${PYTHON_DIR}/bin`
/** Container path of the task-owned scratch volume. */
export const SCRATCH_DIR = '/tmp'
/** Fail-closed floor checked before the gate; the rehearsal needs > 10 GiB. */
export const MIN_SCRATCH_BYTES = 12 * 1024 ** 3

/** Anonymous (task-owned, removed with the container) scratch volume. */
export function scratchMount() {
  return `type=volume,destination=${SCRATCH_DIR}`
}

/** Shell run in the container before anything writes to /tmp. */
export const PREPARE_SCRATCH = [
  'set -eu',
  `avail=$(df -Pk ${SCRATCH_DIR} | awk 'NR==2 {print $4}')`,
  `echo "scratch ${SCRATCH_DIR}: $((avail / 1048576)) GiB free"`,
  `[ "$avail" -ge ${MIN_SCRATCH_BYTES / 1024} ] || { echo "scratch volume ${SCRATCH_DIR} has less than ${MIN_SCRATCH_BYTES / 1024 ** 3} GiB free on the Docker host disk" >&2; exit 1; }`,
  `[ -w ${SCRATCH_DIR} ] || { echo "scratch volume ${SCRATCH_DIR} is not writable" >&2; exit 1; }`,
].join('\n')

/**
 * Shell run inside the container (as the service user) before the gate.
 * Fails closed when python3 or any library of it or its extension modules is
 * absent, then proves pyexpat, ssl and sqlite3 import through the wrapper.
 */
export const PREPARE_PYTHON = [
  'set -eu',
  `P=${PYTHON_DIR}`,
  'real=$(readlink -f /opt/gate-tools/bin/python3 2>/dev/null || true)',
  '[ -n "$real" ] && [ -x "$real" ] || { echo "Node image has no python3 under /usr/bin" >&2; exit 1; }',
  'mkdir -p "$P/lib" "$P/bin"',
  'for dir in /opt/gate-tools/lib/*-linux-gnu; do',
  '  triplet=${dir##*/}',
  '  for lib in "$dir"/*.so*; do',
  '    name=${lib##*/}',
  '    [ -e "/usr/lib/$triplet/$name" ] || [ -e "/lib/$triplet/$name" ] || [ -e "$P/lib/$name" ] || ln -s "$lib" "$P/lib/$name"',
  '  done',
  'done',
  'printf \'#!/bin/sh\\nLD_LIBRARY_PATH=%s exec %s "$@"\\n\' "$P/lib" "$real" > "$P/bin/python3"',
  'chmod 0755 "$P/bin/python3"',
  'missing=$(for f in "$real" /opt/gate-tools/lib/python3*/lib-dynload/*.so; do LD_LIBRARY_PATH="$P/lib" ldd "$f" | grep "not found" | sed "s|^|$f: |"; done || true)',
  '[ -z "$missing" ] || { echo "python3 libraries missing: $missing" >&2; exit 1; }',
  `[ "$P/bin" = "${PYTHON_BIN_DIR}" ]`,
  `PATH="${PYTHON_BIN_DIR}:$PATH" python3 -I -c 'import pyexpat, ssl, sqlite3, sys; print("python3", sys.version.split()[0], "expat", pyexpat.EXPAT_VERSION)'`,
].join('\n')

/** Self-test predicates for the runtime part of the docker plan: [name, ok][]. */
export function runtimePlanChecks(calls, plan) {
  const create = calls[0]
  const steps = plan.map((step) => step.label)
  const at = (label) => steps.indexOf(label)
  const gate = calls.at(-1) ?? []
  const path = (gate.find((arg) => arg.startsWith('PATH=')) ?? '').split(':')
  path[0] = path[0]?.slice(5)
  return [
    [
      'python3 runs through the wrapper with only missing image libraries',
      path.includes(PYTHON_BIN_DIR) &&
        path.indexOf(PYTHON_BIN_DIR) < path.indexOf('/opt/gate-tools/bin') &&
        at('prepare python runtime') > at('prepare home') &&
        at('prepare python runtime') < at('npm run check:all') &&
        /import pyexpat/.test(PREPARE_PYTHON) &&
        !/\b(curl|wget|apt-get|pip|npx)\b/.test(PREPARE_PYTHON),
    ],
    [
      '/tmp is a task-owned anonymous volume checked for free space first',
      create.includes(scratchMount()) &&
        at('check scratch space') >= 0 &&
        at('check scratch space') < at('prepare home') &&
        MIN_SCRATCH_BYTES > 10 * 1024 ** 3,
    ],
  ]
}
