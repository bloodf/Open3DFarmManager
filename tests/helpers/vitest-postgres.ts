import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  POSTGRES_IMAGE_PATTERN,
  type DockerCommand,
} from './disposable-postgres.ts'

/** Docker settings for Vitest fixtures; default mode retains the native provider. */
export function vitestPostgresOptions(name: string) {
  if (process.env.OPENFARM_PG !== 'docker') return { name }

  const docker: DockerCommand = async (...args) => runDocker(args)
  function runDocker(args: string[]): string {
    try {
      return execFileSync('docker', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      }).trim()
    } catch (error) {
      throw new Error(
        'Docker PostgreSQL fixture requires an available local Docker daemon and image',
        { cause: error },
      )
    }
  }
  const endpoint =
    process.env.DOCKER_HOST ??
    runDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  if (!/^unix:\/\//.test(endpoint))
    throw new Error('Only a local Docker daemon is allowed')
  const image =
    process.env.POSTGRES_TEST_IMAGE ??
    runDocker([
      'image',
      'inspect',
      'postgres:17',
      '--format',
      '{{index .RepoDigests 0}}',
    ]).replace(/^postgres@/, 'postgres:17@')
  if (!POSTGRES_IMAGE_PATTERN.test(image)) {
    throw new Error(
      'POSTGRES_TEST_IMAGE must be a locally available digest-pinned PostgreSQL 17 image',
    )
  }
  return { name: `${name}-${randomUUID()}`, docker, image }
}
