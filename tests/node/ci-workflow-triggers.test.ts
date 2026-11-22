import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
)

test('Checks runs on pull requests, main pushes, and manual dispatch', async () => {
  const workflow = parse(await readFile(workflowPath, 'utf8'))

  assert.deepEqual(workflow.on, {
    pull_request: null,
    push: { branches: ['main'] },
    workflow_dispatch: null,
  })
  assert.equal(workflow.concurrency['cancel-in-progress'], true)
  assert.equal(workflow.jobs.e2e.if, "github.event_name == 'workflow_dispatch'")
  assert.equal(workflow.jobs.postgres.if, undefined)

  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'e2e') continue
    const steps = (job as { steps?: Array<{ run?: string }> }).steps ?? []
    assert.equal(
      steps.some((step) => step.run?.includes('test:e2e')),
      false,
      `${name} must not run E2E tests`,
    )
  }
})
