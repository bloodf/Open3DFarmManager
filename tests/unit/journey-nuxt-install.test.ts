import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveNuxtInstall } from '../journey/nuxt-install.ts'

let root: string

async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value))
}

async function fakeNuxt(nodeModules: string, version: string) {
  const dir = join(nodeModules, 'nuxt')
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeJson(join(dir, 'package.json'), {
    name: 'nuxt',
    version,
    bin: { nuxi: 'bin/nuxt.mjs', nuxt: 'bin/nuxt.mjs' },
  })
  await writeFile(join(dir, 'bin/nuxt.mjs'), '')
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'o3dfm-nuxt-install-')))
  await writeJson(join(root, 'package.json'), { workspaces: ['apps/*'] })
  await mkdir(join(root, 'apps/farm'), { recursive: true })
  await writeJson(join(root, 'apps/farm/package.json'), { name: 'farm' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveNuxtInstall', () => {
  it('finds nuxt hoisted to the workspace root', async () => {
    await fakeNuxt(join(root, 'node_modules'), '4.0.0')
    await expect(resolveNuxtInstall(join(root, 'apps/farm'))).resolves.toEqual({
      nodeModules: join(root, 'node_modules'),
      cli: join(root, 'node_modules/nuxt/bin/nuxt.mjs'),
    })
  })

  it('prefers a nuxt nested in the workspace', async () => {
    await fakeNuxt(join(root, 'node_modules'), '4.0.0')
    await fakeNuxt(join(root, 'apps/farm/node_modules'), '4.1.0')
    await expect(resolveNuxtInstall(join(root, 'apps/farm'))).resolves.toEqual({
      nodeModules: join(root, 'apps/farm/node_modules'),
      cli: join(root, 'apps/farm/node_modules/nuxt/bin/nuxt.mjs'),
    })
  })

  it('reports a missing install clearly', async () => {
    await expect(resolveNuxtInstall(join(root, 'apps/farm'))).rejects.toThrow(
      /nuxt is not installed/,
    )
  })
})
