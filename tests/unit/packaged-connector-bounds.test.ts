import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPackagedConnectorManifest } from '../helpers/packaged-connector-bounds.ts'

const noticeDirectory = 'notices/node-datachannel'
const noticeSource = new URL(
  '../../packages/connector/notices/node-datachannel',
  import.meta.url,
)
let dist: string

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'openfarm-247-packaged-'))
  await mkdir(join(dist, 'notices'))
  await cp(noticeSource, join(dist, noticeDirectory), { recursive: true })
  await writeFile(join(dist, 'cli.js'), 'cli')
  await writeFile(join(dist, 'chunk-EXAMPLE.js'), 'chunk')
  await writeFile(join(dist, 'cli.js.LEGAL.txt'), 'legal')
})

afterEach(async () => {
  await rm(dist, { recursive: true, force: true })
})

describe('packaged Connector bounds', () => {
  it('hashes split build files and copied native notices', async () => {
    const manifest = await readPackagedConnectorManifest(dist)
    expect(manifest.map(({ name }) => name)).toEqual([
      'chunk-EXAMPLE.js',
      'cli.js',
      'cli.js.LEGAL.txt',
      'notices/node-datachannel/.gitattributes',
      'notices/node-datachannel/detect-libc-LICENSE',
      'notices/node-datachannel/json-LICENSE',
      'notices/node-datachannel/libdatachannel-LICENSE',
      'notices/node-datachannel/libjuice-LICENSE',
      'notices/node-datachannel/libsrtp-LICENSE',
      'notices/node-datachannel/node-datachannel-LICENSE',
      'notices/node-datachannel/OpenSSL-Apache-2.0-LICENSE',
      'notices/node-datachannel/OpenSSL-LICENSE',
      'notices/node-datachannel/plog-LICENSE',
      'notices/node-datachannel/usrsctp-LICENSE',
    ])
    expect(manifest[1]).toEqual({
      name: 'cli.js',
      bytes: 3,
      sha256: createHash('sha256').update('cli').digest('hex'),
    })
  })

  it('counts notices toward the 96-file limit', async () => {
    for (let i = 0; i < 82; i++)
      await writeFile(join(dist, `chunk-${i}.js`), '')
    await expect(readPackagedConnectorManifest(dist)).resolves.toHaveLength(96)
    await writeFile(join(dist, noticeDirectory, 'extra-LICENSE'), '')
    await expect(readPackagedConnectorManifest(dist)).rejects.toThrow(
      'Packaged file bound',
    )
  })

  it.each(['other', 'notices/other', noticeDirectory + '/nested'])(
    'rejects unexpected directory %s',
    async (name) => {
      await mkdir(join(dist, name))
      await expect(readPackagedConnectorManifest(dist)).rejects.toThrow(
        'Packaged file bound',
      )
    },
  )

  it.each(['notices', noticeDirectory, noticeDirectory + '/link'])(
    'rejects symlink %s',
    async (name) => {
      const path = join(dist, name)
      await rm(path, { recursive: true, force: true })
      await symlink(join(dist, 'cli.js'), path)
      await expect(readPackagedConnectorManifest(dist)).rejects.toThrow(
        'Packaged file bound',
      )
    },
  )

  it('enforces the 2 MiB per-file limit on a notice', async () => {
    const notice = join(dist, noticeDirectory, 'extra-LICENSE')
    await writeFile(notice, '')
    await truncate(notice, 2 * 1024 * 1024)
    await expect(readPackagedConnectorManifest(dist)).resolves.toHaveLength(15)
    await truncate(notice, 2 * 1024 * 1024 + 1)
    await expect(readPackagedConnectorManifest(dist)).rejects.toThrow(
      'Packaged byte bound',
    )
  })

  it('counts notices toward the 16 MiB total byte limit', async () => {
    for (let i = 0; i < 8; i++) {
      const file = join(dist, noticeDirectory, `extra-${i}-LICENSE`)
      await writeFile(file, '')
      await truncate(file, 2 * 1024 * 1024)
    }
    await expect(readPackagedConnectorManifest(dist)).rejects.toThrow(
      'Packaged byte bound',
    )
  })
})
