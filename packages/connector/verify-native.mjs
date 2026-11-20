import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const hashes = {
  'android-arm64':
    '9dbb5e6136f3416be0b13445a5cb8d7f7f6cba96d6a3fffd4b9441edb689b4db',
  'darwin-arm64':
    '325829afa497aaf11e2d2ebb18c0232cc57c4b802adfd1b405327ffdca4ee8d6',
  'darwin-x64':
    'cf0a30d2ce3663f62d37e52fbd57e4c55d22ad16bf57542b53ea34a33a8cd85f',
  'linux-arm64-gnu':
    'c90753d8f41bcd5019d887ca5370d741b92159c59b3b76401ed73f3ab25e502e',
  'linux-arm64-musl':
    '41cf8787881135d25296c30bf219d102891230ac7b49b23c32b8d4fd328aa8e3',
  'linux-x64-gnu':
    'ebadcb570e5b2a51156cb485015b67dd76d6152002c90e39a7a41ed564068f4b',
  'linux-x64-musl':
    '20730aceca33f4d934c69ffe6c1d21c216ab6a249b820b9307f1a7ae38e33ed4',
  'win32-arm64-msvc':
    'e0294cdccd6fae3a4d683638e6187302262a1f5a7479784881ec3f5d70170fdb',
  'win32-x64-msvc':
    '38d531bf9210559205b3ddea2f72fc9eaee7bad72f24c83987b4257665994cbe',
}
export function verifyNative(name, bytes) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (!hashes[name] || actual !== hashes[name])
    throw new Error(`Unverified node-datachannel binary: ${name} (${actual})`)
}
export function verifyInstalledNative() {
  const require = createRequire(import.meta.url)
  const wrapperEntry = require.resolve('node-datachannel')
  const wrapperRequire = createRequire(wrapperEntry)
  const wrapperRoot = resolve(dirname(wrapperEntry), '../../..')
  const wrapper = JSON.parse(
    readFileSync(join(wrapperRoot, 'package.json'), 'utf8'),
  )
  if (wrapper.version !== '0.33.6') {
    throw new Error(`Unverified node-datachannel version: ${wrapper.version}`)
  }

  // Both ESM and CJS loaders try these local builds before the npm prebuilt.
  for (const root of [wrapperRoot, join(wrapperRoot, 'dist')]) {
    for (const directory of ['build', 'build/Release', 'build/Debug']) {
      const candidate = join(root, directory, 'node_datachannel.node')
      if (existsSync(candidate))
        throw new Error(`Unverified local node-datachannel build: ${candidate}`)
    }
  }

  const libc =
    process.platform === 'linux'
      ? wrapperRequire('detect-libc').familySync()
      : null
  const suffix =
    process.platform === 'linux'
      ? libc === 'glibc'
        ? '-gnu'
        : libc === 'musl'
          ? '-musl'
          : '-unknown'
      : process.platform === 'win32'
        ? '-msvc'
        : ''
  const name = `${process.platform}-${process.arch}${suffix}`
  const platformPackage = `@node-datachannel/${name}`
  const bindingPath = wrapperRequire.resolve(platformPackage)
  const manifest = JSON.parse(
    readFileSync(join(dirname(bindingPath), 'package.json'), 'utf8'),
  )
  if (
    manifest.name !== platformPackage ||
    manifest.version !== wrapper.version
  ) {
    throw new Error(
      `Unverified node-datachannel package: ${manifest.name}@${manifest.version}`,
    )
  }
  verifyNative(name, readFileSync(bindingPath))
}
