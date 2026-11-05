import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  assertArtifactSeal,
  assertSplitTrees,
} from '../helpers/signalling-https-split-pin.ts'

test('split pin rejects production changes, removed files and dirty inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signal-split-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim()
  try {
    git('init')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'user.name', 'fixture')
    await mkdir(join(root, 'scripts'), { recursive: true })
    await mkdir(join(root, 'apps'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'scripts/hidden.ts\n')
    await writeFile(join(root, 'scripts/test-signalling-https.ts'), 'old')
    await writeFile(join(root, 'apps/app.ts'), 'app')
    git('add', '.')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    await writeFile(join(root, 'scripts/test-signalling-https.ts'), 'new')
    git('add', '.')
    git('commit', '-m', 'fixture')
    const head = git('rev-parse', 'HEAD')
    assert.doesNotThrow(() => assertSplitTrees(root, base, head))
    await writeFile(join(root, 'scripts/hidden.ts'), 'ignored')
    assert.throws(() => assertSplitTrees(root, base, head))
    await rm(join(root, 'scripts/hidden.ts'))
    await writeFile(join(root, 'untracked'), 'x')
    assert.throws(() => assertSplitTrees(root, base, head))
    await rm(join(root, 'untracked'))
    await writeFile(join(root, 'apps/app.ts'), 'changed')
    assert.throws(() => assertSplitTrees(root, base, head))
    git('add', '.')
    git('commit', '-m', 'app')
    assert.throws(() => assertSplitTrees(root, base, git('rev-parse', 'HEAD')))
    await rm(join(root, 'apps/app.ts'))
    git('add', '-A')
    git('commit', '-m', 'remove')
    assert.throws(() => assertSplitTrees(root, base, git('rev-parse', 'HEAD')))
    await writeFile(join(root, 'apps/new.ts'), 'added')
    git('add', '.')
    git('commit', '-m', 'add')
    assert.throws(() => assertSplitTrees(root, base, git('rev-parse', 'HEAD')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('split artifact seal rejects config and output tampering', () => {
  const expected = { configSha256: 'a', outputSha256: 'b', outputFiles: 455 }
  assert.doesNotThrow(() => assertArtifactSeal(expected, expected))
  assert.throws(() =>
    assertArtifactSeal({ ...expected, configSha256: 'c' }, expected),
  )
  assert.throws(() =>
    assertArtifactSeal({ ...expected, outputSha256: 'c' }, expected),
  )
  assert.throws(() =>
    assertArtifactSeal({ ...expected, outputFiles: 456 }, expected),
  )
})
