import { projectVersion } from '@open3dfarmmanager/shared'

export default defineEventHandler(() => ({
  status: 'ok',
  version: projectVersion,
  checks: { process: 'ok' },
}))
