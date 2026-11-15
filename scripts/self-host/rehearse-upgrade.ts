import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export type Runner = (
  args: string[],
  input?: Buffer | string,
) => Promise<string>
export interface Options {
  backup: string
  to: string
  image: string
}
interface Snapshot {
  counts: Record<string, string>
  configuration: Record<string, string[]>
}
function objectEntries(value: unknown): [string, unknown][] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid snapshot object')
  return Object.entries(value)
}
function parseSnapshot(text: string): Snapshot {
  const root = new Map(objectEntries(JSON.parse(text)))
  const counts = Object.fromEntries(
    objectEntries(root.get('counts')).map(([key, value]) => {
      if (typeof value !== 'string' || !/^\d+$/.test(value))
        throw new Error('Invalid row count')
      return [key, value]
    }),
  )
  const configuration = Object.fromEntries(
    objectEntries(root.get('configuration')).map(([key, value]) => {
      if (
        !Array.isArray(value) ||
        !value.every((row) => typeof row === 'string')
      )
        throw new Error('Invalid configuration snapshot')
      const rows: string[] = value
      return [key, rows]
    }),
  )
  return { counts, configuration }
}
export const snapshotSql = `
BEGIN ISOLATION LEVEL REPEATABLE READ;
CREATE TEMP TABLE rehearsal_counts (name text, count text);
CREATE TEMP TABLE rehearsal_config (name text, rows jsonb);
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      AND schemaname NOT LIKE 'pg_%'
      AND NOT (schemaname = 'public' AND tablename = 'open3dfarm_migrations')
    ORDER BY schemaname, tablename
  LOOP
    EXECUTE format('INSERT INTO rehearsal_counts SELECT %L, count(*)::text FROM %I.%I',
      t.schemaname || '.' || t.tablename, t.schemaname, t.tablename);
    IF t.schemaname = 'farm' AND t.tablename LIKE 'configuration\\_%' ESCAPE '\\' THEN
      EXECUTE format('INSERT INTO rehearsal_config SELECT %L, coalesce(jsonb_agg(value ORDER BY value COLLATE "C"), ''[]''::jsonb) FROM (SELECT to_jsonb(r)::text AS value FROM %I.%I r) s',
        t.schemaname || '.' || t.tablename, t.schemaname, t.tablename);
    END IF;
  END LOOP;
END $$;
SELECT json_build_object(
  'counts', coalesce((SELECT json_object_agg(name, count ORDER BY name) FROM rehearsal_counts), '{}'::json),
  'configuration', coalesce((SELECT json_object_agg(name, rows ORDER BY name) FROM rehearsal_config), '{}'::json));
ROLLBACK;
`
function checksum(configuration: Snapshot['configuration']) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(configuration).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex')
}

// Never inherit a deployment manifest, environment, ports, mounts or networks.
export function disposableCompose(project: string, image: string) {
  if (!/^o3dfm-rehearse-[a-f0-9-]{36}$/.test(project))
    throw new Error('Live project or volume target refused')
  const databaseUrl = 'postgres://rehearsal:rehearsal@postgres:5432/rehearsal'
  return {
    services: {
      postgres: {
        image:
          'postgres:17@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b',
        environment: {
          POSTGRES_USER: 'rehearsal',
          POSTGRES_PASSWORD: 'rehearsal',
          POSTGRES_DB: 'rehearsal',
        },
        volumes: ['data:/var/lib/postgresql/data'],
        healthcheck: {
          test: ['CMD', 'pg_isready', '-U', 'rehearsal', '-d', 'rehearsal'],
          interval: '1s',
          timeout: '3s',
          retries: 30,
        },
        networks: ['isolated'],
      },
      release: {
        image,
        environment: {
          NUXT_DATABASE_ENABLED: 'true',
          NUXT_DATABASE_DATABASE_URL: databaseUrl,
          NUXT_DATABASE_MIGRATIONS: 'apply',
        },
        networks: ['isolated'],
        healthcheck: {
          test: [
            'CMD',
            'node',
            '-e',
            "fetch('http://127.0.0.1:3000/readyz').then(async r=>{const b=await r.json();process.exit(r.ok&&b.checks?.database==='ok'?0:1)}).catch(()=>process.exit(1))",
          ],
          interval: '1s',
          timeout: '3s',
          retries: 60,
        },
      },
    },
    volumes: { data: { name: `${project}-data` } },
    networks: { isolated: { internal: true } },
  }
}

export async function rehearseUpgrade(options: Options, run: Runner) {
  if (!options.backup || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.to))
    throw new Error('Backup and target version required')
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*$/.test(options.image) ||
    !options.image.endsWith(`:${options.to}`)
  )
    throw new Error('Release image must have the requested version tag')
  const backup = await readFile(options.backup)
  if (backup.subarray(0, 5).toString() !== 'PGDMP')
    throw new Error('Expected a pg_dump custom-format backup')
  const project = `o3dfm-rehearse-${randomUUID()}`
  const directory = await mkdtemp(join(tmpdir(), 'o3dfm-rehearse-'))
  const compose = join(directory, 'compose.json')
  const base = ['compose', '--project-name', project, '-f', compose]
  const exec = [...base, 'exec', '-T', 'postgres']
  let started = false
  let retainManifest = false
  let stage = 'prepare'
  let failure: unknown
  let report:
    | {
        project: string
        version: string
        before: Record<string, string>
        after: Record<string, string>
        mismatches: { table: string; before: string; after: string }[]
        configuration: { before: string; after: string }
        ok: boolean
      }
    | undefined
  try {
    await writeFile(
      compose,
      JSON.stringify(disposableCompose(project, options.image)),
      { mode: 0o600 },
    )
    stage = 'pull'
    await run([...base, 'pull'])
    stage = 'start database'
    started = true
    await run([
      ...base,
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
    ])
    stage = 'restore backup'
    await run(
      [
        ...exec,
        'pg_restore',
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        '-U',
        'rehearsal',
        '-d',
        'rehearsal',
      ],
      backup,
    )
    const snapshot = async () =>
      parseSnapshot(
        await run(
          [
            ...exec,
            'psql',
            '-X',
            '-qAt',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            'rehearsal',
            '-d',
            'rehearsal',
          ],
          snapshotSql,
        ),
      )
    stage = 'read baseline'
    const before = await snapshot()
    stage = 'migrate release'
    await run([
      ...base,
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '180',
      'release',
    ])
    stage = 'stop release'
    await run([...base, 'stop', 'release'])
    stage = 'read migrated data'
    const after = await snapshot()
    const mismatches = Object.entries(before.counts)
      .filter(([table, count]) => after.counts[table] !== count)
      .map(([table, count]) => ({
        table,
        before: count,
        after: after.counts[table] ?? 'missing',
      }))
    // Newly introduced empty configuration tables do not change existing configuration.
    const existingConfiguration = Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(before.configuration),
          ...Object.keys(after.configuration).filter(
            (table) => after.configuration[table]!.length > 0,
          ),
        ]),
      ].map((table) => [table, after.configuration[table] ?? ['<missing>']]),
    )
    const beforeChecksum = checksum(before.configuration)
    const afterChecksum = checksum(existingConfiguration)
    const configurationMatches = beforeChecksum === afterChecksum
    report = {
      project,
      version: options.to,
      before: before.counts,
      after: after.counts,
      mismatches,
      configuration: { before: beforeChecksum, after: afterChecksum },
      ok: mismatches.length === 0 && configurationMatches,
    }
  } catch {
    failure = new Error(
      `Rehearsal failed at ${stage} for ${project}; live installation untouched`,
    )
  } finally {
    if (started) {
      try {
        await run([...base, 'down', '--volumes', '--remove-orphans'])
      } catch {
        retainManifest = true
        failure = new Error(
          `Rehearsal cleanup failed for ${project}; retained manifest: ${compose}`,
        )
      }
    }
    if (!retainManifest) await rm(directory, { recursive: true, force: true })
  }
  if (failure) throw failure
  if (!report) throw new Error('Rehearsal produced no report')
  return report
}

export const dockerRunner: Runner = async (args, input) =>
  new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (key.startsWith('COMPOSE_')) delete env[key]
    const child = spawn('docker', args, {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stdin.on('error', () => {})
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error('Docker command failed')),
    )
    child.stdin.end(input)
  })

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        backup: { type: 'string' },
        to: { type: 'string' },
        image: { type: 'string' },
      },
    })
    const report = await rehearseUpgrade(
      {
        backup: values.backup ?? '',
        to: values.to ?? '',
        image: values.image ?? process.env.O3DFM_REHEARSAL_IMAGE ?? '',
      },
      dockerRunner,
    )
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Rehearsal failed')
    process.exitCode = 1
  }
}
