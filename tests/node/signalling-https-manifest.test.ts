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

test('internal relative links are sealed by target; escaping links are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signalling-manifest-'))
  try {
    await mkdir(join(root, 'server/node_modules/a/node_modules'), {
      recursive: true,
    })
    await mkdir(join(root, 'server/node_modules/shared'))
    await writeFile(join(root, 'server/index.mjs'), 'entry')
    await symlink(
      '../../shared',
      join(root, 'server/node_modules/a/node_modules/shared'),
    )
    const source = { head: 'a'.repeat(40), sourceSha256: 'b'.repeat(64) }
    const sealed = await createFixtureReceipt(root, source, 'c'.repeat(64))
    assert.equal(sealed.receipt.outputFiles, 2)
    await rm(join(root, 'server/node_modules/a/node_modules/shared'))
    await symlink(
      '../../../index.mjs',
      join(root, 'server/node_modules/a/node_modules/shared'),
    )
    const retargeted = await createFixtureReceipt(root, source, 'c'.repeat(64))
    assert.notEqual(
      sealed.receipt.outputSha256,
      retargeted.receipt.outputSha256,
    )
    await symlink('/etc', join(root, 'server/absolute'))
    await assert.rejects(
      createFixtureReceipt(root, source, 'c'.repeat(64)),
      /escapes/,
    )
    await rm(join(root, 'server/absolute'))
    await symlink('../../outside', join(root, 'server/escape'))
    await assert.rejects(
      createFixtureReceipt(root, source, 'c'.repeat(64)),
      /escapes/,
    )
    await rm(join(root, 'server/escape'))
    // Lexically inside, but the chain resolves outside: s -> t, t -> ../..
    await symlink('t', join(root, 'server/s'))
    await symlink('../..', join(root, 'server/t'))
    await assert.rejects(
      createFixtureReceipt(root, source, 'c'.repeat(64)),
      /escapes/,
    )
    await rm(join(root, 'server/s'))
    await rm(join(root, 'server/t'))
    // A link to the output root itself is refused.
    await symlink('..', join(root, 'server/root'))
    await assert.rejects(
      createFixtureReceipt(root, source, 'c'.repeat(64)),
      /escapes/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
