import { spawn } from 'node:child_process'
import { open, rm, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

export type Runner = (args: string[], output?: string) => Promise<string>
export interface Options {
  version: string
  compose: string
  backup: string
  ready: string
  dryRun?: boolean
}
export function plan(o: Options) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(o.version))
    throw new Error('A target version is required')
  if (!o.compose || !o.backup)
    throw new Error('Compose and backup paths required')
  const url = new URL(o.ready)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Readiness must use loopback')
  return [
    'preflight: validate persistent volumes and disk',
    'backup: pg_dump',
    `pull: ${o.version}`,
    'up: migrations=apply',
    'wait: /readyz',
  ]
}
export function volumes(config: any) {
  const result: Record<string, string> = {}
  for (const service of Object.values(config.services ?? {}) as any[]) {
    for (const mount of service.volumes ?? []) {
      if (mount.type !== 'volume' || !config.volumes?.[mount.source]?.name)
        throw new Error('All data mounts must be explicitly named volumes')
      result[mount.source] = config.volumes[mount.source].name
    }
  }
  // The Connector CLI requires --data-dir; deployments choose its location.
  const command = config.services?.connector?.command
  const args: unknown[] = Array.isArray(command)
    ? command
    : typeof command === 'string'
      ? command.split(/\s+/)
      : []
  const flag = args.findIndex((arg) => arg === '--data-dir')
  const inline = args.find(
    (arg) => typeof arg === 'string' && arg.startsWith('--data-dir='),
  )
  const connectorTarget =
    flag >= 0
      ? args[flag + 1]
      : typeof inline === 'string'
        ? inline.slice('--data-dir='.length)
        : undefined
  for (const [service, target] of [
    ['postgres', '/var/lib/postgresql/data'],
    ['connector', connectorTarget],
  ] as const) {
    if (
      typeof target !== 'string' ||
      !target.startsWith('/') ||
      !config.services?.[service]?.volumes?.some(
        (mount: { target?: string; type?: string; source?: string }) =>
          mount.target === target &&
          mount.type === 'volume' &&
          mount.source &&
          config.volumes?.[mount.source]?.name,
      )
    )
      throw new Error(
        'Deployment must include postgres and connector persistent volumes on their data paths',
      )
  }
  return JSON.stringify(Object.entries(result).sort())
}
export async function upgrade(
  o: Options,
  run: Runner,
  freeBytes: () => Promise<number>,
  removeBackup: (path: string) => Promise<void> = (path) =>
    rm(path, { force: true }),
) {
  const steps = plan(o)
  if (o.dryRun) return steps.join('\n')
  const base = ['compose', '-f', o.compose]
  let backedUp = false
  try {
    const config = JSON.parse(
      await run([...base, 'config', '--format', 'json']),
    )
    const application = Object.values(config.services ?? {}).find(
      (s: any) => s.environment?.NUXT_DATABASE_MIGRATIONS === 'apply',
    ) as any
    if (!application?.image?.endsWith(':' + o.version))
      throw new Error('Release or migration configuration missing')
    const before = volumes(config)
    if ((await freeBytes()) < 1024 ** 3)
      throw new Error('Insufficient backup disk space')
    try {
      await run(
        [
          ...base,
          'exec',
          '-T',
          'postgres',
          'sh',
          '-c',
          'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
        ],
        o.backup,
      )
    } catch (error) {
      await removeBackup(o.backup)
      throw error
    }
    backedUp = true
    const after = volumes(
      JSON.parse(await run([...base, 'config', '--format', 'json'])),
    )
    if (before !== after) throw new Error('Volume change refused')
    await run([...base, 'pull'])
    await run([...base, 'up', '-d'])
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await run(['ready', o.ready])) === 'ok')
        return 'Upgrade ready; backup retained'
    }
    throw new Error('Readiness timeout')
  } catch (error) {
    throw new Error(
      `Upgrade stopped. ${backedUp ? 'Backup completed.' : 'Backup not confirmed; do not pull.'} Restore: stop application writers; select the previous release; restore the backup with pg_restore into the dedicated database; start the previous release and verify /readyz. Preserve all volumes and Connector configuration.`,
      { cause: error },
    )
  }
}

async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'string' },
      compose: { type: 'string' },
      backup: { type: 'string' },
      ready: { type: 'string', default: 'http://127.0.0.1:3000/readyz' },
      'dry-run': { type: 'boolean' },
    },
  })
  process.env.O3DFM_VERSION = values.version
  process.env.NUXT_DATABASE_MIGRATIONS = 'apply'
  const createdBackups = new Set<string>()
  console.log(
    await upgrade(
      {
        version: values.version ?? '',
        compose: values.compose ?? '',
        backup: values.backup ?? '',
        ready: values.ready!,
        ...(values['dry-run'] === undefined
          ? {}
          : { dryRun: values['dry-run'] }),
      },
      async (args, output) => {
        if (args[0] === 'ready') {
          try {
            const response = await fetch(args[1]!, {
              signal: AbortSignal.timeout(2000),
            })
            if (response.ok) return 'ok'
          } catch {
            // Readiness is polled until ready or until the bounded retry count ends.
          }
          await new Promise((resolve) => setTimeout(resolve, 2000))
          return ''
        }
        if (args.includes('down') || args.includes('-v'))
          throw new Error('Destructive command refused')
        const file = output ? await open(output, 'wx', 0o600) : undefined
        if (output) createdBackups.add(output)
        try {
          return await new Promise<string>((resolve, reject) => {
            const child = spawn('docker', args, {
              stdio: ['ignore', file ? file.fd : 'pipe', 'ignore'],
            })
            let data = ''
            child.stdout?.on('data', (chunk) => {
              data += chunk
            })
            child.on('error', reject)
            child.on('close', (code) =>
              code === 0 ? resolve(data) : reject(new Error('Command failed')),
            )
          })
        } finally {
          await file?.close()
        }
      },
      async () => {
        const s = await statfs(dirname(values.backup!))
        return s.bavail * s.bsize
      },
      async (path) => {
        if (!createdBackups.delete(path)) return
        await rm(path, { force: true })
      },
    ),
  )
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
