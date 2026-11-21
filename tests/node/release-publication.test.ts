import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const commit = 'a'.repeat(40)
const tag = 'v1.2.3'
const files = [
  'farm-v1.2.3-image.tar.gz',
  'connector-v1.2.3-image.tar.gz',
  'connector-v1.2.3-linux-amd64.tar.gz',
] as const
const workflow = readFileSync(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const publishStep =
  /          node --input-type=module <<'PUBLISH_RELEASE'\n([\s\S]+?)^          PUBLISH_RELEASE$/m.exec(
    workflow,
  )
assert.ok(publishStep?.[1], 'Expected the publication script in the workflow')
const script = publishStep[1].replace(/^ {10}/gm, '')
const digest = (contents: string) =>
  createHash('sha256').update(contents).digest('hex')

interface State {
  tag?: string
  annotated?: boolean
  release?: {
    id: number
    tag_name: string
    target_commitish: string
    draft: boolean
  }
  assets?: Array<{ name: string; digest: string; state: string }>
  images?: Record<string, string>
  fail?: string
  pullError?: string
  writes?: string[]
}

function fixture(t: TestContext, initial: State = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'openfarm-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'state.json')
  const manifest = files
    .map((file) => {
      writeFileSync(join(dir, file), file)
      return `${digest(file)}  ${file}\n`
    })
    .join('')
  writeFileSync(join(dir, 'SHA256SUMS'), manifest)
  writeFileSync(stateFile, JSON.stringify(initial))
  const mock = `#!${process.execPath}
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const [command, subject, ...args] = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync('state.json'))
const save = () => fs.writeFileSync('state.json', JSON.stringify(state))
const emit = value => console.log(JSON.stringify(value))
const fail = message => { console.error(message); process.exit(1) }
const mutate = (label, action) => {
  if (state.fail === label) {
    delete state.fail
    save()
    fail('simulated interruption at ' + label)
  }
  action()
  ;(state.writes ??= []).push(label)
  save()
}
const tag = 'v1.2.3'
const commit = process.env.GITHUB_SHA
if (path.basename(process.argv[1]) === 'docker') {
  const image = args.at(-1) ?? subject
  const id = image.includes('farm:') ? 'farm-id' : 'connector-id'
  if (command === 'login' || command === 'load' || command === 'tag') process.exit(0)
  if (command === 'image') console.log(image.startsWith('ghcr.io/') ? state.images[image] : id)
  else if (command === 'pull') {
    if (state.fail === 'registry') fail('Error response from daemon: unauthorized')
    if (state.pullError) fail(state.pullError.replace('<destination>', image))
    if (!state.images?.[image]) fail('Error response from daemon: manifest unknown')
  } else if (command === 'push') {
    mutate('push:' + id, () => { (state.images ??= {})[image] = id })
  } else fail('Unexpected docker call')
} else if (command === 'api') {
  const route = subject.replace('repos/Owner/Repo/', '')
  if (route.startsWith('git/matching-refs/')) {
    emit([
      { ref: 'refs/tags/' + tag + '0', object: { type: 'commit', sha: 'other' } },
      ...(state.tag ? [{ ref: 'refs/tags/' + tag, object: state.annotated
        ? { type: 'tag', sha: 'annotation' }
        : { type: 'commit', sha: state.tag } }] : []),
    ])
  } else if (route === 'git/tags/annotation') emit({ object: { type: 'commit', sha: state.tag } })
  else if (route === 'git/refs') mutate('tag', () => { state.tag = commit })
  else if (route === 'releases?per_page=100') { if (state.release) emit(state.release) }
  else if (route === 'releases/1/assets?per_page=100') (state.assets ?? []).forEach(emit)
  else if (route === 'releases') {
    mutate('draft', () => { state.release = { id: 1, tag_name: tag, target_commitish: commit, draft: true } })
    emit(state.release)
  } else if (route === 'releases/1' && args.includes('draft=false')) {
    mutate('publish', () => { state.release.draft = false })
  } else fail('Unexpected API call: ' + route)
} else if (command === 'release' && subject === 'upload' && args.length === 2) {
  const name = args[1]
  mutate('upload:' + name, () => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex')
    ;(state.assets ??= []).push({ name, digest: 'sha256:' + digest, state: 'uploaded' })
  })
} else fail('Unexpected gh call')
`
  for (const command of ['gh', 'docker'])
    writeFileSync(join(dir, command), mock, { mode: 0o755 })
  return {
    run: () =>
      spawnSync(process.execPath, ['--input-type=module'], {
        input: script,
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          VERSION: '1.2.3',
          GITHUB_SHA: commit,
          GH_REPO: 'Owner/Repo',
          GH_TOKEN: 'fake',
          GITHUB_ACTOR: 'test',
        },
      }),
    state: (): State => JSON.parse(readFileSync(stateFile, 'utf8')),
    corrupt: () => writeFileSync(join(dir, files[0]), 'changed'),
  }
}

for (const fail of [
  'push:connector-id',
  'draft',
  'upload:' + files[1],
  'publish',
]) {
  test(`resumes after interruption at ${fail}`, (t) => {
    const f = fixture(t, { fail })
    const interrupted = f.run()
    assert.equal(interrupted.status, 1, interrupted.stderr)
    assert.match(interrupted.stderr, /simulated interruption/)
    assert.equal(f.state().tag, commit)

    const resumed = f.run()
    assert.equal(resumed.status, 0, resumed.stderr)
    const published = f.state()
    assert.equal(published.release?.draft, false)
    assert.deepEqual(published.writes, [
      'tag',
      'push:farm-id',
      'push:connector-id',
      'draft',
      ...[...files, 'SHA256SUMS'].map((file) => 'upload:' + file),
      'publish',
    ])

    const repeated = f.run()
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.deepEqual(f.state(), published)
  })
}

test('resumes a matching annotated tag', (t) => {
  const f = fixture(t, { tag: commit, annotated: true })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.state().writes?.includes('tag'), false)
})

for (const [label, initial, message] of [
  [
    'different commit',
    { tag: 'b'.repeat(40), annotated: true },
    /expected commit/,
  ],
  [
    'different image',
    { images: { 'ghcr.io/owner/repo/connector:v1.2.3': 'different' } },
    /differs from/,
  ],
  ['registry authorization failure', { fail: 'registry' }, /unauthorized/],
  [
    'different draft target',
    {
      tag: commit,
      release: { id: 1, tag_name: tag, target_commitish: 'other', draft: true },
    },
    /cannot be tied/,
  ],
  [
    'different existing asset',
    {
      tag: commit,
      release: { id: 1, tag_name: tag, target_commitish: commit, draft: true },
      assets: [
        { name: files[0], digest: 'sha256:different', state: 'uploaded' },
      ],
    },
    /mismatched asset/,
  ],
  [
    'incomplete published release',
    {
      tag: commit,
      release: { id: 1, tag_name: tag, target_commitish: commit, draft: false },
    },
    /missing assets/,
  ],
] satisfies Array<[string, State, RegExp]>) {
  test(`refuses ${label} before any publication writes`, (t) => {
    const f = fixture(t, initial)
    const result = f.run()
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, message)
    assert.deepEqual(f.state(), initial)
  })
}

test('checks archive integrity before publication', (t) => {
  const f = fixture(t)
  f.corrupt()
  assert.equal(f.run().status, 1)
  assert.deepEqual(f.state(), {})
})

for (const message of [
  'Error response from daemon: manifest unknown',
  'Error response from daemon: manifest for <destination> not found: manifest unknown: manifest unknown',
]) {
  test(`pushes on exact missing image: ${message}`, (t) => {
    const f = fixture(t, { pullError: message })
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.ok(f.state().writes?.includes('push:farm-id'))
  })
}

for (const message of [
  'Error response from daemon: manifest for ghcr.io/other/image:v1.2.3 not found: manifest unknown: manifest unknown',
  'Error response from daemon: manifest unknown: unauthorized',
]) {
  test(`refuses unrelated registry error: ${message}`, (t) => {
    const f = fixture(t, { pullError: message })
    const result = f.run()
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /manifest unknown/)
    assert.equal(
      f.state().writes?.some((write) => write.startsWith('push:')) ?? false,
      false,
    )
  })
}
