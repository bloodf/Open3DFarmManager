// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  NETWORK_FAULT_BOUND_MS,
  assertFarmReadOnly,
  assertFarmStatusFlowing,
} from '../helpers/sim-netfault-observation.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const harness = join(root, 'infra/sim/netfault')
const compose = JSON.parse(
  readFileSync(join(harness, 'docker-compose.json'), 'utf8'),
)
const profiles = ['nat', 'netem', 'udp-block']

for (const profile of profiles) {
  test(`${profile}: compose parses offline and isolates the Connector`, () => {
    // JSON is a YAML subset, so no daemon, CLI or installed packages are needed.
    assert.ok(compose.services.connector.profiles.includes(profile))
    assert.equal(compose.services.connector.network_mode, 'service:lan-gw')
    assert.equal(compose.networks.wan.internal, true)
    assert.equal(
      compose.networks.lan.driver_opts[
        'com.docker.network.bridge.enable_ip_masquerade'
      ],
      'false',
    )
    for (const service of Object.values(compose.services)) {
      assert.ok(service && typeof service === 'object')
      assert.equal('privileged' in service, false)
      assert.equal('ports' in service, false)
      assert.notEqual('network_mode' in service && service.network_mode, 'host')
      assert.ok('labels' in service)
      assert.deepEqual(service.labels, {
        'org.open3dfarmmanager.netfault':
          '${NETFAULT_PROJECT:?run through run.sh}',
      })
    }
    for (const network of Object.values(compose.networks)) {
      assert.ok(network && typeof network === 'object' && 'labels' in network)
      assert.deepEqual(network.labels, {
        'org.open3dfarmmanager.netfault':
          '${NETFAULT_PROJECT:?run through run.sh}',
      })
    }
  })
}

test('Compose parses offline and installed Docker validates every profile', (t) => {
  for (const profile of profiles)
    assert.ok(compose.services.connector.profiles.includes(profile))
  const available = spawnSync('docker', ['--version'], { encoding: 'utf8' })
  if (
    available.error &&
    'code' in available.error &&
    available.error.code === 'ENOENT'
  ) {
    t.diagnostic(
      'Docker is absent; offline profile parsing passed; CLI validation unavailable',
    )
    return
  }
  assert.equal(available.status, 0, available.stderr)
  for (const profile of profiles) {
    const result = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        join(harness, 'docker-compose.json'),
        '--profile',
        profile,
        'config',
        '--format',
        'json',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NETFAULT_PROJECT: 'o3dfm-offline-test',
          NETFAULT_NDC: tmpdir(),
        },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.ok(JSON.parse(result.stdout).services.connector)
  }
})

test('run and teardown scope deletion to the owned, labelled Compose project', () => {
  const source = readFileSync(join(harness, 'run.sh'), 'utf8')
  assert.equal(spawnSync('bash', ['-n', join(harness, 'run.sh')]).status, 0)
  assert.match(source, /docker compose -p "\$project"/)
  assert.match(source, /label=com\.docker\.compose\.project=\$project/)
  assert.match(source, /org\.open3dfarmmanager\.netfault/)
  assert.match(source, /\[\[ \$owner == "\$project" \]\]/)
  assert.match(source, /dc --profile "\$scenario" down --volumes/)
  assert.doesNotMatch(
    source,
    /--remove-orphans|--rmi|\bprune\b|network_mode: host/,
  )
  assert.match(source, /trap finish EXIT/)
})

test('run refuses a foreign existing project before teardown or build', () => {
  const directory = mkdtempSync(join(tmpdir(), 'netfault-offline-'))
  try {
    const docker = join(directory, 'docker')
    const calls = join(directory, 'calls')
    writeFileSync(
      docker,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nif [ "$1 $2" = "container ls" ]; then echo foreign; fi\n',
    )
    chmodSync(docker, 0o700)
    const result = spawnSync(
      'bash',
      [join(harness, 'run.sh'), 'nat', '1', directory],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: directory + delimiter + process.env.PATH,
          CALLS: calls,
          NETFAULT_PROJECT: 'o3dfm-offline-test',
        },
      },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /refusing reuse/)
    assert.doesNotMatch(readFileSync(calls, 'utf8'), /down|rm|build|exec/)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('farm read-only and flowing assertions enforce the 10 s boundary', () => {
  assert.equal(NETWORK_FAULT_BOUND_MS, 10_000)
  assertFarmReadOnly({ elapsedMs: 10_000, readOnly: true, statusUpdates: 0 })
  assertFarmStatusFlowing({
    elapsedMs: 10_000,
    readOnly: false,
    statusUpdates: 1,
  })
  assert.throws(() =>
    assertFarmReadOnly({ elapsedMs: 10_001, readOnly: true, statusUpdates: 0 }),
  )
  assert.throws(() =>
    assertFarmStatusFlowing({
      elapsedMs: 10_001,
      readOnly: false,
      statusUpdates: 1,
    }),
  )
  assert.throws(() =>
    assertFarmReadOnly({ elapsedMs: 1, readOnly: false, statusUpdates: 0 }),
  )
  assert.throws(() =>
    assertFarmStatusFlowing({
      elapsedMs: 1,
      readOnly: false,
      statusUpdates: 0,
    }),
  )
  assert.throws(() =>
    assertFarmStatusFlowing({ elapsedMs: 1, readOnly: true, statusUpdates: 1 }),
  )
  assert.throws(() =>
    assertFarmReadOnly({ elapsedMs: -1, readOnly: true, statusUpdates: 0 }),
  )
  const farm = readFileSync(
    join(root, 'tests/helpers/sim-farm-acceptance.ts'),
    'utf8',
  )
  assert.match(
    farm,
    /export \{[\s\S]*assertFarmReadOnly,[\s\S]*assertFarmStatusFlowing,[\s\S]*from '\.\/sim-netfault-observation\.ts'/,
  )
})

test('probe failures cannot become successful runs', () => {
  for (const [profile, bind, observation, succeeds] of [
    [
      'nat',
      'any',
      { signalling: 'ok', bind: 'any', rtc: 'open', echoed: 40, openMs: 200 },
      true,
    ],
    [
      'netem',
      'any',
      { signalling: 'ok', bind: 'any', rtc: 'open', echoed: 1, openMs: 9000 },
      true,
    ],
    [
      'udp-block',
      'any',
      { signalling: 'ok', bind: 'any', rtc: 'failed' },
      true,
    ],
    [
      'nat',
      'loopback',
      { signalling: 'ok', bind: 'loopback', rtc: 'failed' },
      true,
    ],
    [
      'netem',
      'any',
      { signalling: 'ok', bind: 'any', rtc: 'open', echoed: 0, openMs: 200 },
      false,
    ],
    ['nat', 'any', { signalling: 'failed', bind: 'any', rtc: 'failed' }, false],
    ['nat', 'any', null, false],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(harness, 'validate-result.mjs')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SCENARIO: String(profile),
          BIND: String(bind),
          RESULT: JSON.stringify(observation),
        },
      },
    )
    assert.equal(result.status === 0, succeeds, result.stderr)
  }
})

for (const foreign of [false, true]) {
  test(`teardown ${foreign ? 'preserves foreign resources' : 'propagates startup failure and removes owned resources'}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'netfault-teardown-'))
    try {
      const calls = join(directory, 'calls')
      const docker = join(directory, 'docker')
      writeFileSync(
        docker,
        `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  'image inspect') exit 1 ;;
  'container ls')
    if [ -f "$STATE" ]; then echo owned-id; fi
    exit 0 ;;
  'container inspect') echo "$OWNER"; exit 0 ;;
esac
if [ "$1" = compose ]; then
  case "$*" in
    *' up '*) touch "$STATE"; exit 7 ;;
  esac
fi
`,
      )
      chmodSync(docker, 0o700)
      // Supply a tiny dependency closure without requiring pnpm in offline tests.
      const realpath = join(directory, 'realpath')
      writeFileSync(realpath, '#!/bin/sh\nprintf "%s/ndc\\n" "$FIXTURE"\n')
      chmodSync(realpath, 0o700)
      const result = spawnSync(
        'bash',
        [join(harness, 'run.sh'), 'nat', '1', directory],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: directory + delimiter + process.env.PATH,
            CALLS: calls,
            STATE: join(directory, 'state'),
            FIXTURE: directory,
            OWNER: foreign ? 'another-task' : 'o3dfm-offline-test',
            NETFAULT_PROJECT: 'o3dfm-offline-test',
          },
        },
      )
      assert.notEqual(result.status, 0)
      const commands = readFileSync(calls, 'utf8')
      if (foreign) {
        assert.match(result.stderr, /refusing cleanup/)
        assert.equal(commands.match(/--profile nat down --volumes/g)?.length, 1)
        assert.doesNotMatch(commands, /image rm/)
      } else {
        assert.equal(result.status, 7)
        assert.match(commands, /--profile nat down --volumes/)
      }
    } finally {
      rmSync(directory, { recursive: true })
    }
  })
}
