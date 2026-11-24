import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../..', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

test('Farm runtime image copies project license and third-party notices', () => {
  const dockerfile = read('apps/farm/Dockerfile')
  const stages = dockerfile.split(/^FROM /m).slice(1)
  const runtime = stages.at(-1) ?? ''

  assert.match(
    runtime,
    /^COPY --from=build --chown=10001:10001 \/app\/LICENSE \/app\/THIRD_PARTY\.md \/app\/THIRD_PARTY_NOTICES\.md \.\/$/m,
  )
})
