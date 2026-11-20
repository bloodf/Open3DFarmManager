import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
const rehearsal = readFileSync('scripts/self-host/real-rehearsal.ts', 'utf8')

test('release build waits for the enabled Docker rehearsal', () => {
  assert.match(workflow, /  rehearsal:\n[\s\S]*?fetch-depth: 0/)
  assert.match(workflow, /OPENFARM_DOCKER_REHEARSAL: '1'/)
  assert.match(workflow, /run: npm run test:upgrade-rehearsal/)
  assert.match(workflow, /  build:\n    needs: rehearsal/)
  assert.match(workflow, /  publish:\n    needs: build/)
  assert.doesNotMatch(workflow, /pull_request:/)
})

test('rehearsal isolates and cleans its compose project', () => {
  assert.match(rehearsal, /o3dfm-real-\$\{randomUUID\(\)\}/)
  assert.match(rehearsal, /'--project-name', project/)
  assert.match(rehearsal, /compose\('down', '--volumes', '--remove-orphans'\)/)
  assert.match(rehearsal, /Cleanup incomplete/)
})
