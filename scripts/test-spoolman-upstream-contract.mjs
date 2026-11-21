import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const image =
  'ghcr.io/donkie/spoolman@sha256:1ebb4f6a62c2e72a07f18b07ebfdbd96322f5bc2eb72570af3088f68d7c393b1'
const name = `o3dfm-contract-548-${randomUUID()}`
const fixtures = JSON.parse(
  await readFile(
    new URL(
      '../tests/fixtures/spoolman/upstream-contract/requests.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
const python = `import json,sys,urllib.request,urllib.error
r=json.load(sys.stdin)
data=json.dumps(r['body']).encode() if r['body'] is not None else None
headers={'Content-Type':'application/json'} if data is not None else {}
req=urllib.request.Request('http://127.0.0.1:8000'+r['path'],data=data,headers=headers,method=r['method'])
try: response=urllib.request.urlopen(req,timeout=5)
except urllib.error.HTTPError as error: response=error
print(json.dumps({'status':response.status,'response':json.load(response)}))`

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
    ...options,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`,
    )
  return result.stdout.trim()
}
function request(fixture) {
  return JSON.parse(
    docker(['exec', '-i', name, 'python', '-c', python], {
      input: JSON.stringify(fixture),
    }),
  )
}
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (['registered', 'first_used', 'last_used'].includes(key)) {
          assert.match(item, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
          return [key, '<timestamp>']
        }
        return [key, normalize(item)]
      }),
    )
  return value
}
let primaryError
let replayFailed = false
try {
  console.log(`container ${name}`)
  docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    name,
    '--network',
    'none',
    '--label',
    'org.open3dfarmmanager.task=upstream-contract-548',
    '--label',
    `org.open3dfarmmanager.owner=${name}`,
    image,
  ])
  let ready = false
  for (let i = 0; i < 90; i++) {
    try {
      const health = request({
        method: 'GET',
        path: '/api/v1/health',
        body: null,
      })
      if (health.status === 200 && health.response.status === 'healthy') {
        ready = true
        break
      }
    } catch {
      /* service is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(ready, 'Spoolman did not become ready')
  for (const fixture of fixtures) {
    const actual = request(fixture)
    assert.equal(actual.status, fixture.status, `${fixture.name}: status`)
    assert.deepEqual(
      normalize(actual.response),
      fixture.response,
      `${fixture.name}: response`,
    )
    console.log(`ok ${fixture.name}`)
  }
} catch (error) {
  primaryError = error
  replayFailed = true
}
try {
  const inspection = spawnSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{ index .Config.Labels "org.open3dfarmmanager.owner" }}',
      name,
    ],
    { encoding: 'utf8', timeout: 30000 },
  )
  if (inspection.error) throw inspection.error
  if (inspection.status === 0) {
    assert.equal(
      inspection.stdout.trim(),
      name,
      'Refusing to remove a container without the task ownership label',
    )
    docker(['rm', '-f', '-v', name])
  } else if (!/no such object/i.test(inspection.stderr)) {
    throw new Error(
      `Could not inspect task container for cleanup: ${inspection.stderr}`,
    )
  }
} catch (error) {
  if (!replayFailed) throw error
  console.error('Container cleanup also failed:', error)
}
if (replayFailed) throw primaryError
