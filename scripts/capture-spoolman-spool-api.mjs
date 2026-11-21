// Records the pinned upstream Spoolman v0.27.1 answers for the spool API
// contract cases, so the farm-scoped implementation can be replayed against
// real upstream behaviour without running upstream in the test.
//
//   node scripts/capture-spoolman-spool-api.mjs
//
// Runs the locally present, digest-identified image in one task-owned
// container with no network (requests are issued from inside it), with a fresh
// database, and removes it on exit. Writes
// tests/fixtures/spoolman/spool-api/upstream.json.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const IMAGE_ID =
  'sha256:1ebb4f6a62c2e72a07f18b07ebfdbd96322f5bc2eb72570af3088f68d7c393b1'
const SOURCE_REVISION = 'ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b'
const IMAGE_REF =
  process.env.SPOOLMAN_IMAGE_REF ?? 'ghcr.io/donkie/spoolman:0.27.1'
const OWNER_LABEL = 'org.open3dfarmmanager.owner'
const TASK_LABEL =
  process.env.SPOOLMAN_CAPTURE_TASK_LABEL ?? 'spoolman-spool-api-540'
const PREFIX = process.env.SPOOLMAN_CAPTURE_PREFIX ?? 'o3dfm-capture-540'
const name = `${PREFIX}-${randomBytes(4).toString('hex')}`
const fixtures = new URL('../tests/fixtures/spoolman/spool-api/', import.meta.url)
const casesText = await readFile(new URL('cases.json', fixtures), 'utf8')
const casesSha256 = createHash('sha256').update(casesText).digest('hex')
const cases = JSON.parse(casesText)

// Inside the container: requests in order, each answered with status, body
// and x-total-count. One exec for the whole list keeps Docker round-trips low.
const python = `import json,sys,urllib.request,urllib.error
out=[]
for r in json.load(sys.stdin):
    if 'rawBody' in r: data=r['rawBody'].encode()
    elif 'body' in r: data=json.dumps(r['body']).encode()
    else: data=None
    headers={}
    if data is not None: headers['Content-Type']=r.get('contentType','application/json')
    req=urllib.request.Request('http://127.0.0.1:8000'+r['path'],data=data,headers=headers,method=r['method'])
    try: response=urllib.request.urlopen(req,timeout=30)
    except urllib.error.HTTPError as error: response=error
    raw=response.read().decode()
    try: body=json.loads(raw)
    except ValueError: body=raw
    out.append({'status':response.status,'total':response.headers.get('x-total-count'),'body':body})
print(json.dumps(out))`

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`,
    )
  return result.stdout.trim()
}
const send = (requests) =>
  JSON.parse(
    docker(['exec', '-i', name, 'python', '-c', python], {
      input: JSON.stringify(requests),
    }),
  )

assert.equal(
  docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE_REF]),
  IMAGE_ID,
  'the pinned Spoolman v0.27.1 image must already be present locally',
)
assert.equal(
  docker([
    'image',
    'inspect',
    '--format',
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
    IMAGE_REF,
  ]),
  SOURCE_REVISION,
  'the pinned Spoolman v0.27.1 image source revision must match upstream.lock.json',
)
const repoDigest =
  docker([
    'image',
    'inspect',
    '--format',
    '{{ if .RepoDigests }}{{ index .RepoDigests 0 }}{{ end }}',
    IMAGE_REF,
  ]) || `${IMAGE_REF}@${IMAGE_ID}`
let failure
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
    `org.open3dfarmmanager.task=${TASK_LABEL}`,
    '--label',
    `${OWNER_LABEL}=${name}`,
    IMAGE_REF,
  ])
  let ready = false
  let lastError = ''
  for (let i = 0; i < 180 && !ready; i++) {
    try {
      ready =
        send([{ method: 'GET', path: '/api/v1/health' }])[0].status === 200
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (lastError.includes('No such container')) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  assert.ok(ready, `Spoolman did not become ready: ${lastError}`)
  const answers = send(cases)
  assert.equal(answers.length, cases.length)
  const recorded = cases.map((request, i) => ({
    ...request,
    status: answers[i].status,
    total: answers[i].total,
    response: answers[i].body,
  }))
  for (const item of recorded) console.log(`${item.status} ${item.name}`)
  await writeFile(
    new URL('upstream.json', fixtures),
    JSON.stringify(
      {
        upstream: 'Spoolman v0.27.1',
        image: IMAGE_ID,
        imageRef: repoDigest,
        sourceRevision: SOURCE_REVISION,
        casesSha256,
        capturedAt: new Date().toISOString(),
        cases: recorded,
      },
      null,
      2,
    ) + '\n',
  )
} catch (error) {
  failure = error
} finally {
  const owner = spawnSync(
    'docker',
    [
      'inspect',
      '--format',
      `{{ index .Config.Labels "${OWNER_LABEL}" }}`,
      name,
    ],
    {
      encoding: 'utf8',
    },
  )
  if (owner.status === 0 && owner.stdout.trim() === name)
    docker(['rm', '-f', '-v', name])
}
if (failure) throw failure
