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
  } catch {
    throw new Error(
      `Upgrade stopped. ${backedUp ? 'Backup completed.' : 'Backup not confirmed; do not pull.'} Restore: stop application writers; select the previous release; restore the backup with pg_restore into the dedicated database; start the previous release and verify /readyz. Preserve all volumes and Connector configuration.`,
    )
  }
}
