import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL(
  '../../scripts/simulator-identify-diagnostic.mjs',
  import.meta.url,
).href
const { verifyComposePin, PINNED_COMPOSE_BASE } = (await import(moduleUrl)) as {
  verifyComposePin: (composeFile: string) => string
  PINNED_COMPOSE_BASE: string
}

const repoCompose = readFileSync(
  new URL('../../infra/sim/docker-compose.yml', import.meta.url),
  'utf8',
)
const repoDockerfile = readFileSync(
  new URL('../../infra/sim/klipper/Dockerfile', import.meta.url),
  'utf8',
)

function harness(compose: string, dockerfile: string) {
  const root = mkdtempSync(join(tmpdir(), 'o3dfm-compose-pin-'))
  mkdirSync(join(root, 'klipper'))
  writeFileSync(join(root, 'docker-compose.yml'), compose)
  writeFileSync(join(root, 'klipper', 'Dockerfile'), dockerfile)
  return root
}

function check(compose: string, dockerfile: string) {
  const root = harness(compose, dockerfile)
  try {
    return verifyComposePin(join(root, 'docker-compose.yml'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('repository compose and Dockerfile pass the pin check', () => {
  assert.match(check(repoCompose, repoDockerfile), /^[0-9a-f]{64}$/)
})

test('rejects a Dockerfile whose final stage is not the pinned digest', () => {
  const builderOnly = `${repoDockerfile}\nFROM debian:bookworm\n`
  assert.throws(
    () => check(repoCompose, builderOnly),
    /does not pin the reviewed multi-platform image digest/,
  )
  assert.throws(
    () =>
      check(
        repoCompose,
        repoDockerfile.replace(PINNED_COMPOSE_BASE, 'busybox'),
      ),
    /does not pin the reviewed multi-platform image digest/,
  )
})

test('rejects printer services that do not build from ./klipper', () => {
  const anchorImageOverride = repoCompose.replace(
    'image: openfarm-klipper:sim',
    'image: busybox',
  )
  assert.notEqual(anchorImageOverride, repoCompose)
  assert.throws(
    () => check(anchorImageOverride, repoDockerfile),
    /do not build from \.\/klipper/,
  )

  const imageOverride = repoCompose.replace(
    '  sv06:\n    <<: *printer\n',
    '  sv06:\n    <<: *printer\n    image: busybox\n',
  )
  assert.notEqual(imageOverride, repoCompose)
  assert.throws(
    () => check(imageOverride, repoDockerfile),
    /do not build from \.\/klipper/,
  )
  const otherContext = repoCompose.replace(
    'context: ./klipper',
    'context: ./other',
  )
  assert.notEqual(otherContext, repoCompose)
  assert.throws(
    () => check(otherContext, repoDockerfile),
    /do not build from \.\/klipper/,
  )
  const noMerge = repoCompose.replace('  u1:\n    <<: *printer\n', '  u1:\n')
  assert.notEqual(noMerge, repoCompose)
  assert.throws(
    () => check(noMerge, repoDockerfile),
    /do not build from \.\/klipper/,
  )
})

test('rejects a platform override that prevents native builds', () => {
  const overridden = repoCompose.replace(
    '  profiles: [klipper]',
    '  platform: linux/amd64\n  profiles: [klipper]',
  )
  assert.throws(
    () => check(overridden, repoDockerfile),
    /overrides native platform selection/,
  )
})
