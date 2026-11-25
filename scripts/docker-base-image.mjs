#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// One dependency image per lockfile, reused by the Docker test runs.
//
//   node scripts/docker-base-image.mjs [--node-image <ref>]   build if missing, print the tag
//   node scripts/docker-base-image.mjs --prune                drop stale openfarm-test-base:* images
//
// The tag is `openfarm-test-base:<hash12>`, covering the lockfile, source Node
// image reference, Dockerfile and npm config. `npm ci` runs only while the image
// is built; that build is the one step that needs the npm registry. Runners copy
// the preinstalled node_modules into their own writable workspace with
// `seedNodeModules`.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createRunDir } from './docker-run-lib.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DOCKERFILE = join(ROOT, 'infra/test-base/Dockerfile')
export const REPOSITORY = 'openfarm-test-base'
/** Where the image holds the manifests and node_modules. */
export const DEPS_DIR = '/opt/openfarm-deps'
export const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Node image of the queue-clock diagnostic. */
export const DIAGNOSTIC_NODE_IMAGE = 'node:22-bookworm'

/** Local Node + Playwright browsers image used by the browser runners. */
export function browserNodeImage(root = ROOT) {
  return `openfarm-e2e-node${readFileSync(join(root, '.nvmrc'), 'utf8').trim()}:latest`
}

/** `name` and `name:latest` are the same image, so they hash the same. */
export function normalizeImageRef(ref) {
  return ref.includes('@') || /:[^/]*$/.test(ref) ? ref : `${ref}:latest`
}

export function lockfileHash(lockfile, nodeImage, dockerfile = '', npmrc = '') {
  return createHash('sha256')
    .update(lockfile)
    .update('\0')
    .update(normalizeImageRef(nodeImage))
    .update('\0')
    .update(dockerfile)
    .update('\0')
    .update(npmrc)
    .digest('hex')
}

export function baseImageTag(lockfile, nodeImage, dockerfile = '', npmrc = '') {
  return `${REPOSITORY}:${lockfileHash(lockfile, nodeImage, dockerfile, npmrc).slice(0, 12)}`
}

export function projectImageTag(projectDir, nodeImage) {
  return baseImageTag(
    readFileSync(join(projectDir, 'package-lock.json')),
    nodeImage,
    readFileSync(join(projectDir, 'infra/test-base/Dockerfile')),
    existsSync(join(projectDir, '.npmrc'))
      ? readFileSync(join(projectDir, '.npmrc'))
      : '',
  )
}

/** The only files the image build sees: lockfile, npm config and manifests. */
export function manifestFiles(projectDir) {
  const files = ['package.json', 'package-lock.json', '.npmrc']
  for (const group of ['apps', 'packages']) {
    if (!existsSync(join(projectDir, group))) continue
    for (const entry of readdirSync(join(projectDir, group)).sort())
      files.push(join(group, entry, 'package.json'))
  }
  return files.filter((file) => existsSync(join(projectDir, file)))
}

export function buildArgs({ tag, nodeImage, context }) {
  return [
    'build',
    '--pull=false',
    '--build-arg',
    `NODE_IMAGE=${nodeImage}`,
    '--tag',
    tag,
    '--file',
    DOCKERFILE,
    context,
  ]
}

// Build output goes to stderr so that stdout carries only the tag.
const dockerSync = (bin) => (args, options) =>
  spawnSync(bin, args, { stdio: ['ignore', 2, 2], ...options })

/**
 * Return the tag for `projectDir`'s lockfile, building the image only when it is
 * missing. The source image must already be local unless `allowPull` is set.
 */
export function ensureBaseImage({
  projectDir = ROOT,
  nodeImage,
  bin = 'docker',
  docker = dockerSync(bin),
  allowPull = false,
}) {
  const tag = projectImageTag(projectDir, nodeImage)
  const present = (ref) =>
    docker(['image', 'inspect', ref], { stdio: 'ignore' }).status === 0
  if (present(tag)) return tag
  if (!allowPull && !present(nodeImage))
    throw new Error(
      `Source image "${nodeImage}" is not present locally; provide it before building ${tag}.`,
    )
  const context = createRunDir('base-context')
  try {
    for (const file of manifestFiles(projectDir)) {
      mkdirSync(dirname(join(context, file)), { recursive: true })
      copyFileSync(join(projectDir, file), join(context, file))
    }
    const built = docker(buildArgs({ tag, nodeImage, context }))
    if (built.status !== 0)
      throw new Error(`docker build of ${tag} failed (${built.status})`)
    return tag
  } finally {
    rmSync(context, { recursive: true, force: true })
  }
}

/** Shell that copies the preinstalled node_modules trees into `destination`. */
export function seedNodeModules(destination = '/work') {
  return [
    `(cd ${DEPS_DIR} && find . -name node_modules -prune -print0 | tar --null -T - -cf -) | tar -C ${destination} -xf -`,
    `[ -d ${destination}/node_modules ] || { echo 'dependency seed from ${DEPS_DIR} failed' >&2; exit 1; }`,
  ].join('\n')
}

/** Tags of the current lockfile for every Node image the runners build from. */
export function currentTags(root = ROOT, env = process.env, extra = []) {
  return new Set(
    [
      browserNodeImage(root),
      DIAGNOSTIC_NODE_IMAGE,
      env.OPENFARM_GATE_NODE_IMAGE,
      ...extra,
    ]
      .filter(Boolean)
      .map((image) => projectImageTag(root, image)),
  )
}

/**
 * References safe to remove: only this repository, older than seven days, and
 * not a current tag. An unreadable creation date keeps the image.
 */
export function selectPrunable(images, { now = Date.now(), keep }) {
  return images
    .filter(
      ({ repository, tag, created }) =>
        repository === REPOSITORY &&
        tag &&
        tag !== '<none>' &&
        !keep.has(`${repository}:${tag}`) &&
        now - Date.parse(created) > PRUNE_AGE_MS,
    )
    .map(({ repository, tag }) => `${repository}:${tag}`)
}

export function pruneBaseImages({
  bin = 'docker',
  docker = (args) => spawnSync(bin, args, { encoding: 'utf8' }),
  keep = currentTags(),
  now = Date.now(),
} = {}) {
  const read = (args) => {
    const result = docker(args)
    if (result.status !== 0)
      throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  const images = read([
    'image',
    'ls',
    '--format',
    '{{.Repository}} {{.Tag}}',
    REPOSITORY,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [repository, tag] = line.split(' ')
      return { repository, tag }
    })
    .filter(({ repository, tag }) => repository === REPOSITORY && tag)
    .filter(({ tag }) => tag !== '<none>')
    .map((image) => ({
      ...image,
      created: read([
        'image',
        'inspect',
        '--format',
        '{{.Created}}',
        `${image.repository}:${image.tag}`,
      ]),
    }))
  // Without --force an image still used by a container is kept.
  return selectPrunable(images, { now, keep }).filter(
    (reference) => docker(['image', 'rm', reference]).status === 0,
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        'node-image': { type: 'string' },
        prune: { type: 'boolean' },
      },
    })
    const nodeImage = values['node-image']
    if (values.prune) {
      const keep = currentTags(ROOT, process.env, [nodeImage])
      for (const reference of pruneBaseImages({ keep }))
        console.log(`removed ${reference}`)
    } else
      console.log(
        ensureBaseImage({ nodeImage: nodeImage ?? browserNodeImage() }),
      )
  } catch (error) {
    console.error(`docker-base-image: ${error.message}`)
    process.exitCode = 1
  }
}
