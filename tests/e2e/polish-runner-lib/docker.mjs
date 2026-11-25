// Command helpers and `docker run` argv builders for the evidence runners.
// Containers are owned by the lifecycle in scripts/docker-run-lib.mjs.
import { execFileSync } from 'node:child_process'
import { TMPFS_TMP } from '../../../scripts/docker-run-lib.mjs'

export function createDocker({ root, env, commands }) {
  const run = (command, args, options = {}) => {
    commands.push([command, ...args].join(' '))
    return execFileSync(command, args, {
      cwd: root,
      stdio: 'inherit',
      env,
      ...options,
    })
  }
  const read = (command, args, options = {}) =>
    run(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options })
      .toString()
      .trim()
  const docker = (args, options) => run('docker', args, options)
  return { run, read, docker }
}

// Pure `docker run` argv builders for the evidence runners. Every host path they
// mount is inside the caller's run directory; everything else is a tmpfs or the
// `--rm` container's own image. Dependencies come preinstalled from the base
// image (scripts/docker-base-image.mjs).
const base = (name) => ['run', '--rm', '--pull=never', '--name', name]
const scratch = ['--tmpfs', TMPFS_TMP]

/** Offline command in the dependency image with a writable tree at /work. */
export function treeRunArgs({ name, image, tree, command }) {
  return [
    ...base(name),
    ...['--network', 'none', '--shm-size=1g'],
    ...scratch,
    ...['-e', 'HOME=/tmp/home', '-e', 'CI=1'],
    ...['-e', 'OPENFARM_BROWSER=bundled', '-e', 'NUXT_TELEMETRY_DISABLED=1'],
    ...['-v', `${tree}:/work`, '-w', '/work', image],
    ...command,
  ]
}

/** Serves one built `.output` directory with no network at all. */
export function polishAppArgs({ name, image, output }) {
  return [
    ...base(name),
    ...['--network', 'none'],
    ...scratch,
    ...['-v', `${output}:/app:ro`, '-w', '/app'],
    ...['-e', 'HOME=/tmp'],
    ...['-e', 'NITRO_HOST=0.0.0.0', '-e', 'NITRO_PORT=3000'],
    ...[image, 'node', 'server/index.mjs'],
  ]
}

/** Playwright in the app container's network namespace. */
export function polishPlaywrightArgs({
  name,
  image,
  app,
  nodeBin,
  tree,
  evidence,
  script,
}) {
  return [
    ...base(name),
    ...['--network', `container:${app}`, '--shm-size=1g'],
    ...scratch,
    ...['-v', `${nodeBin}:/usr/local/bin/node:ro`],
    ...['-v', `${tree}:/work`, '-v', `${evidence}:/evidence`],
    ...['-w', '/work', '-e', 'CI=1', '-e', 'HOME=/tmp'],
    ...[image, 'sh', '-ec', script],
  ]
}

/** Never started: only `docker cp` of its Node binary. */
export function nodeExtractorArgs({ name, image }) {
  return [...base(name), image, 'true']
}

/** The single offline container of the spools and printer evidence runners. */
export function screenEvidenceArgs({ name, image, runDir, script }) {
  return [
    ...base(name),
    ...['--network=none', '--shm-size=1g'],
    ...scratch,
    ...['-e', 'HOME=/tmp/home', '-e', 'CI=1'],
    ...['-e', 'OPENFARM_BROWSER=bundled', '-e', 'NUXT_TELEMETRY_DISABLED=1'],
    ...['-e', 'DO_NOT_TRACK=1'],
    ...['-v', `${runDir}/work:/work`],
    ...['-v', `${runDir}/scratch:/scratch:ro`],
    ...['-v', `${runDir}/evidence:/evidence`],
    ...['-w', '/work', image, 'bash', '-c', script],
  ]
}

export function farmAppArgs({ name, image, network, output }) {
  return [
    ...base(name),
    ...['--network', network],
    ...scratch,
    ...['-v', `${output}:/app:ro`, '-w', '/app'],
    ...['-e', 'HOME=/tmp'],
    ...['-e', 'NITRO_HOST=0.0.0.0', '-e', 'NITRO_PORT=3000'],
    ...[image, 'node', 'server/index.mjs'],
  ]
}

/** Publishes a loopback port and forwards it to the app on the internal network. */
export function farmProxyArgs({ name, image, upstream }) {
  return [
    ...base(name),
    ...['-p', '127.0.0.1::3000'],
    ...scratch,
    ...['-e', 'HOME=/tmp'],
    ...[image, 'node', '-e'],
    `const net = require('node:net'); net.createServer(s => { const upstream = net.connect(3000, '${upstream}'); s.pipe(upstream).pipe(s); upstream.on('error', () => s.destroy()); s.on('error', () => upstream.destroy()) }).listen(3000, '0.0.0.0')`,
  ]
}
