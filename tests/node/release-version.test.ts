import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import manifest from '../../package.json' with { type: 'json' }

const { version } = manifest

test('Connector --version and farm health report the manifest version', () => {
  const cliVersion = execFileSync(
    process.execPath,
    ['packages/connector/src/cli.ts', '--version'],
    {
      encoding: 'utf8',
    },
  ).trim()
  const health = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `globalThis.defineEventHandler = (handler) => handler
         const { default: handler } = await import('./apps/farm/server/routes/healthz.get.ts')
         console.log(JSON.stringify(handler()))`,
      ],
      { encoding: 'utf8' },
    ),
  )
  assert.equal(cliVersion, version)
  assert.deepEqual(health, { status: 'ok', version, checks: { process: 'ok' } })
})

test('dry-run build creates three verifiable archives without publication', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'release-version-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const artifacts = join(directory, 'artifacts')
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env bash
set -eu
case "$1" in
  build|exec|rm) ;;
  run)
    if [[ "$2" == "-d" ]]; then
      echo farm-container
    else
      echo "$TEST_RELEASE_VERSION"
    fi ;;
  save) printf 'mock image archive for %s' "$2" ;;
  create) echo connector-container ;;
  cp) mkdir -p "$3/dist"; echo 'mock CLI' > "$3/dist/cli.js" ;;
  *) echo "Unexpected Docker action: $1" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  execFileSync('bash', ['scripts/build-release.sh', version, artifacts], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TEST_RELEASE_VERSION: version,
    },
  })
  const archives = [
    `connector-v${version}-image.tar.gz`,
    `connector-v${version}-linux-amd64.tar.gz`,
    `farm-v${version}-image.tar.gz`,
  ]
  assert.deepEqual(readdirSync(artifacts).sort(), ['SHA256SUMS', ...archives])
  const checksums = readFileSync(join(artifacts, 'SHA256SUMS'), 'utf8')
    .trim()
    .split('\n')
  assert.deepEqual(
    checksums.sort(),
    archives
      .map((archive) => {
        const digest = createHash('sha256')
          .update(readFileSync(join(artifacts, archive)))
          .digest('hex')
        return `${digest}  ${archive}`
      })
      .sort(),
  )
  const runtime = join(artifacts, `connector-v${version}-linux-amd64.tar.gz`)
  assert.equal(
    execFileSync('tar', ['-xOzf', runtime, './dist/cli.js'], {
      encoding: 'utf8',
    }).trim(),
    'mock CLI',
  )
})
