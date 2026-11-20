import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

test('release upload and publication require a successful rehearsed build', () => {
  const jobs = /^jobs:\n  build:\n([\s\S]+?)^  publish:\n([\s\S]+)$/m.exec(
    workflow,
  )
  assert.ok(jobs)
  const [, build, publish] = jobs
  assert.match(
    build,
    /- uses: actions\/checkout@[^\n]+\n        with:\n          fetch-depth: 0\n/,
  )
  assert.match(
    build,
    /        run: bash scripts\/build-release\.sh "\$VERSION" release-artifacts\n      - uses: actions\/upload-artifact@[^\n]+\n/,
  )
  assert.doesNotMatch(build, /continue-on-error:|^\s+if:/m)
  assert.match(
    publish,
    /^    needs: build\n    if: inputs\.owner_approved && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)\n/,
  )
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:/)
})

test('Docker rehearsal failure blocks archives and cleans only its own project', (t) => {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), 'release-rehearsal-'),
  )
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(
    join(directory, 'git'),
    `#!/bin/bash
set -eu
case "$1 $2" in
  'rev-parse origin/main~1') echo previous ;;
  'rev-parse HEAD') echo current ;;
  'merge-base --is-ancestor'|'worktree list') ;;
  'archive --output') touch "$3" ;;
  *) exit 91 ;;
esac
`,
    { mode: 0o755 },
  )
  writeFileSync(join(directory, 'tar'), '#!/bin/bash\nexit 0\n', {
    mode: 0o755,
  })
  writeFileSync(
    join(directory, 'docker'),
    `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$DOCKER_TRACE"
[[ -z "\${COMPOSE_PROJECT_NAME+x}" ]]
if [[ "$1" == compose && "$6" == up ]]; then
  exit 42
fi
if [[ "$1" == compose && "$6" == down ]]; then
  exit "$DOCKER_DOWN_STATUS"
fi
`,
    { mode: 0o755 },
  )

  const projects = new Set<string>()
  for (const attempt of ['first', 'second']) {
    const cleanupFails = attempt === 'second'
    const trace = join(directory, attempt + '.log')
    const evidence = join(directory, attempt + '-evidence')
    const artifacts = join(directory, attempt + '-artifacts')
    const result = spawnSync(
      'bash',
      ['scripts/build-release.sh', '1.2.3', artifacts],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH}`,
          TMPDIR: directory,
          COMPOSE_PROJECT_NAME: 'foreign-project',
          OPENFARM_DOCKER_REHEARSAL: '0',
          OPENFARM_REHEARSAL_EVIDENCE: evidence,
          DOCKER_TRACE: trace,
          DOCKER_DOWN_STATUS: cleanupFails ? '43' : '0',
        },
      },
    )
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    if (cleanupFails) {
      assert.match(
        result.stdout + result.stderr,
        /Cleanup incomplete; manifest retained/,
      )
    } else {
      assert.match(
        result.stdout + result.stderr,
        /docker compose failed \(42\)/,
      )
    }
    assert.equal(existsSync(artifacts), false)

    const { project, succeeded, failures } = JSON.parse(
      readFileSync(join(evidence, 'cleanup.json'), 'utf8'),
    )
    assert.match(project, /^o3dfm-real-[0-9a-f-]{36}$/)
    assert.equal(succeeded, false)
    if (cleanupFails) {
      assert.equal(failures.length, 1)
      assert.match(failures[0], /docker compose failed \(43\)/)
    } else {
      assert.deepEqual(failures, [])
    }
    projects.add(project)

    const commands = readFileSync(trace, 'utf8').trim().split('\n')
    const compose = commands.filter((command) => command.startsWith('compose '))
    const manifest = compose[0].split(' ')[4]
    assert.ok(dirname(manifest).startsWith(join(directory, project + '-')))
    const prefix = `compose --project-name ${project} -f ${manifest}`
    assert.deepEqual(compose, [
      `${prefix} up -d --wait --wait-timeout 120 postgres`,
      `${prefix} logs --no-color`,
      `${prefix} down --volumes --remove-orphans`,
    ])
    assert.equal(existsSync(dirname(manifest)), cleanupFails)
    assert.deepEqual(
      commands
        .filter((command) => !command.startsWith('compose '))
        .map((command) => command.replace(/ -f .*$/, '')),
      [
        'image ls --no-trunc --format {{.ID}}',
        'ps -aq',
        'volume ls -q',
        `buildx create --name ${project} --driver docker-container`,
        `buildx build --builder ${project} --load -t ${project}:previous`,
        `buildx build --builder ${project} --load -t ${project}:current`,
        `buildx rm ${project}`,
        `image rm ${project}:previous`,
        `image rm ${project}:current`,
        `ps -aq --filter label=com.docker.compose.project=${project}`,
        `volume ls -q --filter label=com.docker.compose.project=${project}`,
        `network ls -q --filter name=^${project}-network$`,
      ],
    )
  }
  assert.equal(projects.size, 2)
})
