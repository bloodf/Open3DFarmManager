import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export type NuxtInstall = Readonly<{
  /** Real path of the `node_modules` directory that holds `nuxt`. */
  nodeModules: string
  /** Real path of the `nuxt` CLI entry script; run it with `process.execPath`. */
  cli: string
}>

/**
 * Finds the `nuxt` a workspace actually resolves, with Node's own lookup from
 * that workspace. npm may hoist it to the repository root (no workspace
 * `node_modules` at all) or keep it nested in the workspace; both are valid
 * installs. The CLI entry comes from the package's `bin` field, so neither the
 * `.bin` shim nor its location is assumed.
 */
export async function resolveNuxtInstall(
  workspace: string,
): Promise<NuxtInstall> {
  const require = createRequire(join(workspace, 'package.json'))
  let manifestPath: string
  try {
    manifestPath = await realpath(require.resolve('nuxt/package.json'))
  } catch (error) {
    throw new Error(
      `nuxt is not installed for ${workspace}; run npm ci at the repository root`,
      { cause: error },
    )
  }
  const packageDir = dirname(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const entry =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.nuxt
  if (!entry) throw new Error(`nuxt at ${packageDir} declares no nuxt binary`)
  return {
    nodeModules: dirname(packageDir),
    cli: await realpath(join(packageDir, entry)),
  }
}
