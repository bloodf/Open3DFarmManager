import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertOutsideRepo,
  prepareEvidenceDir,
} from '../../apps/website/lib/evidence-dir.mjs'

// Fixture "repository" and "outside" trees live in one private temp directory
// that this test creates and removes; no real repository file is touched.
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'openfarm-evidence-test-')),
  )
  const repo = join(root, 'repo')
  const section = join(repo, 'apps', 'website', 'sections', 'hero')
  const outside = join(root, 'outside')
  await mkdir(section, { recursive: true })
  await mkdir(outside)
  const sentinels = {
    png: join(section, 'sentinel.png'),
    json: join(section, 'sentinel.json'),
  }
  await writeFile(sentinels.png, 'repo-png')
  await writeFile(sentinels.json, '{"repo":true}')
  return { root, repo, section, outside, sentinels }
}

async function assertSentinels(
  sentinels: { png: string; json: string },
  section: string,
) {
  assert.equal(await readFile(sentinels.png, 'utf8'), 'repo-png')
  assert.equal(await readFile(sentinels.json, 'utf8'), '{"repo":true}')
  assert.deepEqual((await readdir(section)).sort(), [
    'sentinel.json',
    'sentinel.png',
  ])
}

async function rejects(repo: string, override: string, tmpBase: string) {
  await assert.rejects(
    prepareEvidenceDir({ override, tmpBase, repoRoot: repo }),
    /outside the repository/,
  )
}

test('rejects a final-component symlink into the repository without deleting', async () => {
  const { root, repo, section, outside, sentinels } = await fixture()
  try {
    const link = join(outside, 'evidence')
    await symlink(section, link)
    await rejects(repo, link, outside)
    await assertSentinels(sentinels, section)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a symlinked ancestor into the repository, existing or not yet created', async () => {
  const { root, repo, section, outside, sentinels } = await fixture()
  try {
    const link = join(outside, 'ancestor')
    await symlink(join(repo, 'apps', 'website', 'sections'), link)
    await rejects(repo, join(link, 'hero'), outside)
    await rejects(repo, join(link, 'new-dir', 'deeper'), outside)
    await assertSentinels(sentinels, section)
    // Nothing was created through the link.
    assert.deepEqual(await readdir(join(repo, 'apps', 'website', 'sections')), [
      'hero',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects chained and dangling symlinks that land in the repository', async () => {
  const { root, repo, section, outside, sentinels } = await fixture()
  try {
    const first = join(outside, 'first')
    const second = join(outside, 'second')
    await symlink(section, first)
    await symlink(first, second)
    await rejects(repo, second, outside)
    // Dangling link whose target would be created inside the repository.
    const dangling = join(outside, 'dangling')
    await symlink(join(repo, 'would-be-created'), dangling)
    await rejects(repo, dangling, outside)
    await assertSentinels(sentinels, section)
    await assert.rejects(readdir(join(repo, 'would-be-created')), {
      code: 'ENOENT',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a plain path inside the repository and a symlinked repository root alias', async () => {
  const { root, repo, section, outside, sentinels } = await fixture()
  try {
    await rejects(repo, section, outside)
    const alias = join(outside, 'repo-alias')
    await symlink(repo, alias)
    await rejects(
      repo,
      join(alias, 'apps', 'website', 'sections', 'hero'),
      outside,
    )
    await assertSentinels(sentinels, section)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps working for external directories, symlinks to external directories and the default', async () => {
  const { root, repo, section, outside, sentinels } = await fixture()
  try {
    const evidence = join(outside, 'shots', 'run')
    assert.equal(
      await prepareEvidenceDir({
        override: evidence,
        tmpBase: outside,
        repoRoot: repo,
      }),
      evidence,
    )
    await writeFile(join(evidence, 'old.png'), 'x')
    await writeFile(join(evidence, 'old.json'), '{}')
    await writeFile(join(evidence, 'keep.txt'), 'keep')
    await prepareEvidenceDir({
      override: evidence,
      tmpBase: outside,
      repoRoot: repo,
    })
    assert.deepEqual(await readdir(evidence), ['keep.txt'])

    const external = join(outside, 'real')
    const link = join(outside, 'link-to-external')
    await mkdir(external)
    await symlink(external, link)
    await prepareEvidenceDir({
      override: link,
      tmpBase: outside,
      repoRoot: repo,
    })

    const first = await prepareEvidenceDir({ tmpBase: outside, repoRoot: repo })
    const second = await prepareEvidenceDir({
      tmpBase: outside,
      repoRoot: repo,
    })
    assert.notEqual(first, second)
    assert.ok((await readdir(first)).length === 0)
    await assertOutsideRepo(first, repo)
    await assertSentinels(sentinels, section)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
