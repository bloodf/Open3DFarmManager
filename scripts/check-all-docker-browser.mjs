// SPDX-License-Identifier: MIT
// Browser for the Docker-only `check:all` gate.
//
// The browser suites launch Chrome through tests/helpers/browser.ts, which
// honours OPENFARM_CHROME_PATH as an explicit executable. The gate container
// has no Google Chrome, and nothing may be downloaded, so the runner supplies
// the Chromium that the local Node 22 image already holds for Playwright
// 1.65.1 (/ms-playwright, revision 1255), mounted read-only.
//
// That Chromium was built for the Node image's Ubuntu userland, while the
// container's userland is the PostgreSQL image's Debian. A wrapper therefore
// adds only the shared libraries the container lacks, taken from the Node
// image's read-only /usr mount; libraries the container already provides
// (glibc, libstdc++, zlib, ...) are never shadowed. Everything generated lives
// on the container's /tmp tmpfs and disappears with the container.

/** Where the Node image's Playwright browser cache is mounted. */
export const BROWSER_CACHE_DIR = '/opt/ms-playwright'
/** Generated wrapper; exported to the gate as OPENFARM_CHROME_PATH. */
export const CHROME_WRAPPER = '/tmp/gate-browser/chrome'

/** Read-only image mount exposing the Node image's Playwright browsers. */
export function browserMount(nodeImage) {
  return `type=image,source=${nodeImage},destination=${BROWSER_CACHE_DIR},image-subpath=ms-playwright,readonly`
}

/**
 * Shell run inside the container (as the service user) before the gate.
 * Fails closed when the Chromium or any of its libraries is absent, then
 * proves the wrapper starts the browser binary.
 */
export const PREPARE_BROWSER = [
  'set -eu',
  'B=/tmp/gate-browser',
  `chrome=$(ls -d ${BROWSER_CACHE_DIR}/chromium-*/chrome-linux*/chrome 2>/dev/null | head -n 1)`,
  '[ -n "$chrome" ] && [ -x "$chrome" ] || { echo "Node image has no Playwright Chromium under /ms-playwright" >&2; exit 1; }',
  'mkdir -p "$B/lib" "$B/fontcache"',
  'for dir in /opt/gate-tools/lib/*-linux-gnu; do',
  '  triplet=${dir##*/}',
  '  for lib in "$dir"/*.so*; do',
  '    name=${lib##*/}',
  '    [ -e "/usr/lib/$triplet/$name" ] || [ -e "/lib/$triplet/$name" ] || [ -e "$B/lib/$name" ] || ln -s "$lib" "$B/lib/$name"',
  '  done',
  'done',
  'printf \'%s\\n\' \'<?xml version="1.0"?>\' \'<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\' "<fontconfig><dir>/opt/gate-tools/share/fonts</dir><cachedir>$B/fontcache</cachedir></fontconfig>" > "$B/fonts.conf"',
  'printf \'#!/bin/sh\\nLD_LIBRARY_PATH=%s FONTCONFIG_FILE=%s exec %s "$@"\\n\' "$B/lib" "$B/fonts.conf" "$chrome" > "$B/chrome"',
  'chmod 0755 "$B/chrome"',
  'missing=$(LD_LIBRARY_PATH="$B/lib" ldd "$chrome" | grep "not found" || true)',
  '[ -z "$missing" ] || { echo "Chromium libraries missing: $missing" >&2; exit 1; }',
  `[ "$B/chrome" = "${CHROME_WRAPPER}" ]`,
  '"$B/chrome" --version',
].join('\n')

/** Self-test predicates for the browser part of the docker plan: [name, ok][]. */
export function browserPlanChecks(cfg, calls, plan) {
  const create = calls[0]
  const steps = plan.map((step) => step.label)
  const at = (label) => steps.indexOf(label)
  return [
    [
      'browser suites get the Node image Chromium via OPENFARM_CHROME_PATH',
      create.includes(browserMount(cfg.nodeImage)) &&
        calls.at(-1).includes(`OPENFARM_CHROME_PATH=${CHROME_WRAPPER}`) &&
        at('prepare offline browser') > at('prepare home') &&
        at('prepare offline browser') < at('npm run check:all'),
    ],
    [
      'browser preparation downloads nothing and fails closed',
      !/\b(curl|wget|apt|apt-get|npx|playwright install)\b/.test(
        PREPARE_BROWSER,
      ) &&
        PREPARE_BROWSER.startsWith('set -eu') &&
        /not found/.test(PREPARE_BROWSER),
    ],
  ]
}
