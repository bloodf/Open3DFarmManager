import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFixtureReceipt,
  Receipt,
} from '../helpers/signalling-https-manifest.ts'

test('output file manifest seals into strict receipt and detects changed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signalling-manifest-'))
  try {
    await mkdir(join(root, 'server'))
    await writeFile(join(root, 'server/index.mjs'), 'first')
    const source = { head: 'a'.repeat(40), sourceSha256: 'b'.repeat(64) }
    const first = await createFixtureReceipt(root, source, 'c'.repeat(64))
    assert.equal(first.entries.length, 1)
    assert.equal(first.entries[0]?.path, 'server/index.mjs')
    assert.equal(first.receipt.outputFiles, 1)
    assert.throws(() =>
      Receipt.parse({ ...first.receipt, entries: first.entries }),
    )
    await writeFile(join(root, 'server/index.mjs'), 'second')
    const second = await createFixtureReceipt(root, source, 'c'.repeat(64))
    assert.notEqual(first.receipt.outputSha256, second.receipt.outputSha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('contained output links are sealed by target and escaping links are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signalling-manifest-'))
  const outside = await mkdtemp(join(tmpdir(), 'signalling-manifest-outside-'))
  try {
    await mkdir(join(root, 'server/node_modules/a'), { recursive: true })
    await writeFile(join(root, 'server/index.mjs'), 'entry')
    await symlink('a', join(root, 'server/node_modules/b'))
    const source = { head: 'a'.repeat(40), sourceSha256: 'b'.repeat(64) }
    const sealed = await createFixtureReceipt(root, source, 'c'.repeat(64))
    assert.ok(
      sealed.entries.some((entry) => entry.path === 'server/node_modules/b'),
    )
    await rm(join(root, 'server/node_modules/b'))
    await symlink(join(root, 'server'), join(root, 'server/node_modules/b'))
    const relinked = await createFixtureReceipt(root, source, 'c'.repeat(64))
    assert.notEqual(sealed.receipt.outputSha256, relinked.receipt.outputSha256)
    await symlink(outside, join(root, 'server/node_modules/c'))
    await assert.rejects(
      createFixtureReceipt(root, source, 'c'.repeat(64)),
      /escapes/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
