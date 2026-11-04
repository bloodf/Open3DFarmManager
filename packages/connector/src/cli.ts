#!/usr/bin/env node
import { projectVersion } from '@open3dfarmmanager/shared'
import { parseArgs } from 'node:util'

export function main(args: string[]): number {
  try {
    const { values } = parseArgs({
      args,
      options: { version: { type: 'boolean' }, help: { type: 'boolean' } },
      allowPositionals: false,
    })
    if (values.version) console.log(projectVersion)
    else
      console.log(
        'Open3DFarmManager Connector\n\nOptions:\n  --version  Print version\n  --help     Print help\n\nPairing and printer connections are not implemented yet.',
      )
    return 0
  } catch {
    console.error('Invalid arguments. Use --help.')
    return 1
  }
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2))
