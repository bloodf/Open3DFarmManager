import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  disposableCompose,
  rehearseUpgrade,
  snapshotSql,
  type Runner,
} from '../../scripts/self-host/rehearse-upgrade.ts'

const baseline = {
  counts: { 'farm.printers': '2', 'farm.configuration_operations': '1' },
  configuration: {
    'farm.configuration_operations': ['{"record":{"name":"Printer"}}'],
  },
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rehearse-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const backup = join(directory, 'backup.dump')
  await writeFile(backup, 'PGDMPfixture')
  return { backup, to: 'v2', image: 'example/farm:v2' }
}
function fake(after = baseline, failAt = '') {
  const calls: { args: string[]; input?: Buffer | string }[] = []
  let snapshots = 0
  let manifest: ReturnType<typeof disposableCompose> | undefined
  const run: Runner = async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) })
    const file = args[args.indexOf('-f') + 1]!
    manifest = JSON.parse(await readFile(file, 'utf8'))
    if (failAt && args.includes(failAt)) throw Error('password=secret')
    if (args.includes('psql'))
      return JSON.stringify(snapshots++ ? after : baseline)
    return ''
  }
  return {
    run,
    calls,
    get manifest() {
      return manifest
    },
  }
}
test('restores, compares, migrates the requested release, stops writers and cleans only its project', async (t) => {
  const options = await fixture(t)
  const f = fake()
  const result = await rehearseUpgrade(options, f.run)
  assert.equal(result.ok, true)
  assert.deepEqual(
    f.calls.map(({ args }) => args[5]),
    ['pull', 'up', 'exec', 'exec', 'up', 'stop', 'exec', 'down'],
  )
  assert.deepEqual(f.calls.at(-1)!.args.slice(5), [
    'down',
    '--volumes',
    '--remove-orphans',
  ])
  assert.equal(f.calls[2]!.input?.toString(), 'PGDMPfixture')
  assert.equal(f.calls[3]!.input, snapshotSql)
  assert.equal(f.manifest!.services.release.image, 'example/farm:v2')
  assert.equal(f.manifest!.networks.isolated.internal, true)
  assert.deepEqual(f.manifest!.services.postgres.volumes, [
    'data:/var/lib/postgresql/data',
  ])
  assert.equal('volumes' in f.manifest!.services.release, false)
  assert.equal('ports' in f.manifest!.services.postgres, false)
  const project = f.calls[0]!.args[2]!
  assert.match(project, /^o3dfm-rehearse-[a-f0-9-]{36}$/)
  assert.equal(f.manifest!.volumes.data.name, `${project}-data`)
  assert.ok(f.calls.every(({ args }) => args[2] === project))
  await assert.rejects(access(dirname(f.calls[0]!.args[4]!)))
  assert.equal(await readFile(options.backup, 'utf8'), 'PGDMPfixture')
  const second = fake()
  await rehearseUpgrade(options, second.run)
  assert.notEqual(second.calls[0]!.args[2], project)
})
test('refuses live project or volume targets', () => {
  for (const project of [
    'open3dfarmmanager-app',
    '/live/data',
    'o3dfm-rehearse-live',
  ])
    assert.throws(
      () => disposableCompose(project, 'app:v2'),
      /Live project or volume target refused/,
    )
})
test('reports row loss, missing tables and changed configuration without printing records', async (t) => {
  const options = await fixture(t)
  const f = fake({ counts: { 'farm.printers': '1' }, configuration: {} })
  const report = await rehearseUpgrade(options, f.run)
  assert.equal(report.ok, false)
  assert.deepEqual(report.mismatches, [
    { table: 'farm.printers', before: '2', after: '1' },
    { table: 'farm.configuration_operations', before: '1', after: 'missing' },
  ])
  assert.notEqual(report.configuration.before, report.configuration.after)
  assert.ok(!JSON.stringify(report).includes('Printer'))
})
test('detects config mutation with equal row counts', async (t) => {
  const f = fake({
    counts: baseline.counts,
    configuration: { 'farm.configuration_operations': ['changed'] },
  })
  const report = await rehearseUpgrade(await fixture(t), f.run)
  assert.equal(report.ok, false)
  assert.deepEqual(report.mismatches, [])
})
for (const failAt of ['pg_restore', 'up', 'psql', 'stop']) {
  test(`cleanup runs after ${failAt} failure and redacts command errors`, async (t) => {
    const f = fake(baseline, failAt)
    await assert.rejects(
      rehearseUpgrade(await fixture(t), f.run),
      (error) =>
        String(error).includes('Rehearsal failed') &&
        !String(error).includes('secret'),
    )
    assert.equal(f.calls.at(-1)!.args[5], 'down')
    await assert.rejects(access(dirname(f.calls[0]!.args[4]!)))
  })
}
test('release migration failure still removes the disposable database', async (t) => {
  const f = fake()
  await assert.rejects(
    rehearseUpgrade(await fixture(t), async (args, input) => {
      const result = await f.run(args, input)
      if (args.includes('up') && args.includes('release'))
        throw Error('migration failed')
      return result
    }),
    /Rehearsal failed/,
  )
  assert.equal(f.calls.at(-1)!.args[5], 'down')
})
test('cleanup failure retains the manifest for targeted recovery', async (t) => {
  const f = fake(baseline, 'down')
  await assert.rejects(
    rehearseUpgrade(await fixture(t), f.run),
    /cleanup failed.*retained manifest/,
  )
  const directory = dirname(f.calls[0]!.args[4]!)
  t.after(() => rm(directory, { recursive: true, force: true }))
  await access(join(directory, 'compose.json'))
})
test('invalid version, image and backup cause no Docker calls', async (t) => {
  const options = await fixture(t)
  const f = fake()
  for (const changed of [
    { to: '../live' },
    { image: 'app:v1' },
    { image: 'app:v2; touch /tmp/unsafe' },
  ])
    await assert.rejects(rehearseUpgrade({ ...options, ...changed }, f.run))
  await writeFile(options.backup, 'not a custom dump')
  await assert.rejects(rehearseUpgrade(options, f.run), /custom-format/)
  assert.equal(f.calls.length, 0)
})
test('new migration tables do not imply row loss', async (t) => {
  const f = fake({
    counts: { ...baseline.counts, 'farm.new_table': '0' },
    configuration: { ...baseline.configuration, 'farm.configuration_new': [] },
  })
  assert.equal((await rehearseUpgrade(await fixture(t), f.run)).ok, true)
})

test('malformed snapshot fails closed and still cleans up', async (t) => {
  const f = fake()
  await assert.rejects(
    rehearseUpgrade(await fixture(t), async (args, input) => {
      const result = await f.run(args, input)
      return args.includes('psql')
        ? '{"counts":{"farm.printers":null},"configuration":{}}'
        : result
    }),
    /read baseline/,
  )
  assert.equal(f.calls.at(-1)!.args[5], 'down')
})

test('pull failure does not create or remove database resources', async (t) => {
  const f = fake(baseline, 'pull')
  await assert.rejects(rehearseUpgrade(await fixture(t), f.run), /pull/)
  assert.equal(f.calls.length, 1)
  await assert.rejects(access(dirname(f.calls[0]!.args[4]!)))
})
