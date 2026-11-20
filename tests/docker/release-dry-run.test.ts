import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import manifest from '../../package.json' with { type: 'json' }

const { version } = manifest

test(
  'tagged local release builds verified archives only after rehearsal',
  {
    skip: process.env.OPENFARM_RELEASE_DRY_RUN !== '1',
    timeout: 4_500_000,
  },
  () => {
    const directory = mkdtempSync(
      join(realpathSync(tmpdir()), 'openfarm-release-'),
    )
    const source = join(directory, 'source')
    const bin = join(directory, 'bin')
    const builder = `openfarm-release-${randomUUID()}`
    const tag = `v${version}`
    const images = ['farm', 'connector'].map(
      (component) => `openfarm-${component}:${tag}`,
    )
    const artifacts = join(directory, 'artifacts')
    const exec = (command: string, args: string[]) =>
      execFileSync(command, args, { encoding: 'utf8', timeout: 120_000 }).trim()
    const docker = (...args: string[]) => exec('docker', args)
    let createdBuilder = false
    let buildsAllowed = false
    let passed = false
    const baseline = statfsSync(directory)
    console.log(`Release evidence: ${directory}`)
    try {
      writeFileSync(
        join(directory, 'ledger.log'),
        [
          `Free bytes: ${baseline.bavail * baseline.bsize}`,
          exec('git', ['status', '--porcelain']),
          exec('git', ['worktree', 'list', '--porcelain']),
          docker('context', 'show'),
          docker('ps', '-a', '--no-trunc'),
          docker('image', 'ls', '--no-trunc'),
          docker('volume', 'ls'),
          docker('network', 'ls'),
          docker('system', 'df'),
          `Owned paths: ${source}, ${bin}, ${artifacts}`,
          `Owned builder and image tags: ${builder}, ${images.join(', ')}`,
        ].join('\n'),
      )
      assert.ok(baseline.bavail * baseline.bsize > 10 * 1024 ** 3)
      assert.match(
        version,
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
      )
      for (const image of images) {
        assert.equal(
          docker('image', 'ls', '-q', image),
          '',
          `Image already exists: ${image}`,
        )
      }

      const previous = exec('git', ['rev-parse', 'origin/main'])
      exec('git', [
        'clone',
        '--shared',
        '--no-checkout',
        '--no-tags',
        '.',
        source,
      ])
      const git = (...args: string[]) => exec('git', ['-C', source, ...args])
      git('remote', 'remove', 'origin')
      git('update-ref', 'refs/remotes/origin/main', previous)
      git('tag', tag, 'HEAD')
      git('checkout', '--detach', tag)

      mkdirSync(bin)
      const shim = (name: string, body: string) =>
        writeFileSync(
          join(bin, name),
          `#!/usr/bin/env bash\nset -eu\n${body}\n`,
          { mode: 0o755 },
        )
      shim('gh', 'echo "Publication command rejected" >&2; exit 99')
      shim(
        'node',
        `
[[ "$OPENFARM_DOCKER_REHEARSAL" == 1 ]]
[[ "$#" == 2 && "$1" == --test && "$2" == tests/docker/upgrade-rehearsal.test.ts ]]
if [[ "$FAIL_REHEARSAL" == 1 ]]; then exit 42; fi
export PATH="$ORIGINAL_PATH"
unset NODE_TEST_CONTEXT
exec "$REAL_NODE" "$@"
`,
      )
      shim(
        'docker',
        `
touch "$DOCKER_MARKER"
action=$1
shift
case "$action" in
  build) exec "$REAL_DOCKER" buildx build --builder "$RELEASE_BUILDER" --load "$@" ;;
  run|create) exec "$REAL_DOCKER" "$action" --label "openfarm.release-dry-run=$RELEASE_BUILDER" "$@" ;;
  exec|logs|save|cp|rm) exec "$REAL_DOCKER" "$action" "$@" ;;
  *) echo "Unexpected Docker command: $action" >&2; exit 99 ;;
esac
`,
      )
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ORIGINAL_PATH: process.env.PATH,
        REAL_NODE: process.execPath,
        REAL_DOCKER: exec('which', ['docker']),
        RELEASE_BUILDER: builder,
        DOCKER_MARKER: join(directory, 'docker-called'),
        OPENFARM_REHEARSAL_EVIDENCE: join(directory, 'rehearsal'),
      }
      const build = (fail: boolean) =>
        spawnSync('bash', ['scripts/build-release.sh', version, artifacts], {
          cwd: source,
          env: { ...env, FAIL_REHEARSAL: fail ? '1' : '0' },
          stdio: 'inherit',
          timeout: 4_400_000,
        })
      const failure = build(true)
      assert.ifError(failure.error)
      assert.equal(failure.status, 42)
      assert.equal(existsSync(artifacts), false)
      assert.equal(existsSync(env.DOCKER_MARKER), false)

      execFileSync(
        'npm',
        ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        {
          cwd: source,
          stdio: 'inherit',
          timeout: 300_000,
        },
      )
      docker(
        'buildx',
        'create',
        '--name',
        builder,
        '--driver',
        'docker-container',
      )
      createdBuilder = true
      buildsAllowed = true
      const release = build(false)
      assert.ifError(release.error)
      assert.equal(
        release.status,
        0,
        'Release build, Connector version and farm health must pass',
      )

      const rehearsal = JSON.parse(
        readFileSync(
          join(env.OPENFARM_REHEARSAL_EVIDENCE, 'report.json'),
          'utf8',
        ),
      )
      assert.equal(rehearsal.current, git('rev-parse', tag))
      assert.equal(rehearsal.backupRestored, true)

      const runtime = `connector-${tag}-linux-amd64.tar.gz`
      const archives = [
        `connector-${tag}-image.tar.gz`,
        runtime,
        `farm-${tag}-image.tar.gz`,
      ]
      assert.deepEqual(readdirSync(artifacts).sort(), [
        'SHA256SUMS',
        ...archives,
      ])
      const sums = readFileSync(join(artifacts, 'SHA256SUMS'), 'utf8')
        .trim()
        .split('\n')
      assert.deepEqual(
        sums
          .map((line) => {
            assert.match(line, /^[a-f0-9]{64}  /)
            return line.slice(66)
          })
          .sort(),
        archives,
      )
      execFileSync('sha256sum', ['-c', 'SHA256SUMS'], {
        cwd: artifacts,
        stdio: 'inherit',
      })
      for (const component of ['farm', 'connector']) {
        const manifest = exec('tar', [
          '-xOzf',
          join(artifacts, `${component}-${tag}-image.tar.gz`),
          'manifest.json',
        ])
        assert.deepEqual(
          JSON.parse(manifest).flatMap(
            (entry: { RepoTags: string[] }) => entry.RepoTags,
          ),
          [`openfarm-${component}:${tag}`],
        )
      }
      assert.ok(
        exec('tar', ['-tzf', join(artifacts, runtime)])
          .split('\n')
          .includes('./dist/cli.js'),
      )
      passed = true
    } finally {
      const cleanupErrors: unknown[] = []
      const cleanup = (action: () => void) => {
        try {
          action()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (createdBuilder) cleanup(() => docker('buildx', 'rm', builder))
      if (buildsAllowed) {
        cleanup(() => {
          const filter = `label=openfarm.release-dry-run=${builder}`
          const containers = docker('ps', '-aq', '--filter', filter)
          if (containers) docker('rm', '-fv', ...containers.split('\n'))
          assert.equal(docker('ps', '-aq', '--filter', filter), '')
        })
        for (const image of images) {
          cleanup(() => {
            if (docker('image', 'ls', '-q', image)) docker('image', 'rm', image)
            assert.equal(docker('image', 'ls', '-q', image), '')
          })
        }
      }
      for (const path of [source, bin, artifacts]) {
        cleanup(() => rmSync(path, { recursive: true, force: true }))
      }
      if (passed && cleanupErrors.length === 0)
        rmSync(directory, { recursive: true })
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          `Release cleanup failed: ${directory}`,
        )
    }
  },
)
