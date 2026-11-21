/**
 * `GET /api/v1/info` and `POST /api/v1/backup` of the pinned Spoolman v0.27.1.
 * The built-in server has no data directory to describe and no SQLite file to
 * copy, so `info` carries no host path and `backup` answers with a farm-scoped
 * JSON export instead of writing a file.
 */
import { exportBundle } from './export.ts'
import { methodNotAllowed, respond, type LegacyApiModule } from './types.ts'

export const SPOOLMAN_VERSION = '0.27.1'

export interface InfoOptions {
  externalDbName?: string
}

export function createInfoModule(options: InfoOptions = {}): LegacyApiModule {
  return {
    name: 'info',
    async handle(repo, request) {
      if (request.apiPath === '/api/v1/info') {
        if (request.method !== 'GET') return methodNotAllowed()
        return respond(200, {
          version: SPOOLMAN_VERSION,
          debug_mode: false,
          automatic_backups: false,
          data_dir: '',
          logs_dir: '',
          backups_dir: '',
          db_type: 'postgresql',
          external_db_name:
            options.externalDbName ??
            process.env['EXTERNAL_DB_NAME'] ??
            'SpoolmanDB',
          build_date: null,
          git_commit: null,
          latest_version: null,
          update_available: false,
        })
      }
      if (request.apiPath === '/api/v1/backup') {
        if (request.method !== 'POST') return methodNotAllowed()
        const bundle = await exportBundle(repo)
        if (!bundle.ok) return bundle
        // Upstream: `{path, created}`. No file exists here; `path` names the
        // inline export and `export` carries it (farm-scoped, never a file).
        return respond(200, {
          created: true,
          path: 'inline:export',
          export: bundle.value,
        })
      }
      return undefined
    },
  }
}

export const infoModule = createInfoModule()
