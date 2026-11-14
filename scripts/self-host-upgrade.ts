import { spawn } from 'node:child_process'
import { open, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { upgrade } from './self-host/upgrade.ts'

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    compose: { type: 'string' },
    backup: { type: 'string' },
    ready: { type: 'string', default: 'http://127.0.0.1:3000/readyz' },
    'dry-run': { type: 'boolean' },
  },
})
try {
  // Release interpolation and migration mode are inherited by every Compose invocation.
  process.env.O3DFM_VERSION = values.version
  process.env.NUXT_DATABASE_MIGRATIONS = 'apply'
  console.log(
    await upgrade(
      {
        version: values.version ?? '',
        compose: values.compose ?? '',
        backup: values.backup ?? '',
        ready: values.ready!,
        dryRun: values['dry-run'],
      },
      async (args, output) => {
        if (args[0] === 'ready') {
          try {
            const response = await fetch(args[1]!, {
              signal: AbortSignal.timeout(2000),
            })
            if (response.ok) return 'ok'
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 2000))
          return ''
        }
        if (args.includes('down') || args.includes('-v'))
          throw new Error('Destructive command refused')
        const file = output ? await open(output, 'wx', 0o600) : undefined
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
    ),
  )
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
