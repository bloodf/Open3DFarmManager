import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../..', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

test('Connector image and release copy node-datachannel notices', () => {
  const dockerfile = read('packages/connector/Dockerfile')
  const stages = dockerfile.split(/^FROM /m).slice(1)
  const runtime = stages.at(-1) ?? ''
  assert.match(
    runtime,
    /^COPY packages\/connector\/notices\/node-datachannel \.\/notices\/node-datachannel$/m,
  )
  assert.match(
    runtime,
    /^COPY --from=build \/app\/node_modules\/node-datachannel \.\/node_modules\/node-datachannel$/m,
  )

  const release = read('scripts/build-release.sh')
  const copyAt = release.indexOf(
    'cp -a packages/connector/notices/node-datachannel "$runtime/notices/"',
  )
  const tarAt = release.indexOf(
    'tar -czf "$artifacts/connector-$tag-linux-amd64.tar.gz"',
  )
  assert.ok(copyAt >= 0, 'release script must copy the notices directory')
  assert.ok(
    tarAt > copyAt,
    'notices must be copied before the release archive is packed',
  )

  const notices = readdirSync(
    new URL('packages/connector/notices/node-datachannel', root),
  )
  assert.ok(notices.includes('node-datachannel-LICENSE'))

  const thirdParty = read('THIRD_PARTY.md')
  assert.doesNotMatch(thirdParty, /does not package these notices/)
  assert.match(
    thirdParty,
    /Connector image and the linux-amd64 release archive copy `packages\/connector\/notices\/node-datachannel\/`/,
  )
  assert.match(
    thirdParty,
    /https:\/\/github\.com\/murat-dogan\/node-datachannel\/tree\/6f5c0a2494c20ac9f1250d937856697843bde823/,
  )
})
