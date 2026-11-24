import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'
import { readIntegrationApiQuery } from '../../apps/farm/server/utils/integration-api-query.ts'
import { moonrakerQueryClient } from '../../packages/connector/src/runtime/api-query-moonraker.ts'
import { answerApiQuery } from '../../packages/connector/src/runtime/api-query.ts'
import { listMoonrakerMacros } from '../../packages/connector/src/moonraker/macros.ts'
import type { FileListTarget } from '../../packages/connector/src/runtime/file-list.ts'
import {
  ApiQueryResult,
  apiQueryScopes,
  type ApiQueryKind,
} from '../../packages/farm-protocol/src/api-query.ts'
import {
  decodeSignallingClientFrame,
  decodeSignallingServerFrame,
  encodeSignallingClientFrame,
  encodeSignallingServerFrame,
} from '../../packages/farm-protocol/src/signalling-socket.ts'

const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const agentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const printerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const otherPrinterId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function fixture(
  kind: ApiQueryKind,
  source: { files: FileListTarget } | { macros: readonly string[] } | undefined,
) {
  const scope = apiQueryScopes[kind]
  let calls = 0
  let replyError: 'connector-timeout' | 'connector-unavailable' | undefined
  const input: Omit<Parameters<typeof readIntegrationApiQuery>[0], 'request'> =
    {
      headers: { 'ratelimit-remaining': '40' },
      principal: {
        appId: 'app',
        scopes: [scope],
        grants: [
          {
            id: 'grant',
            appId: 'app',
            farmId,
            printerAssignmentId: printerId,
            scopes: [scope],
            requiresApproval: false,
            createdAt: 0,
            disabledAt: null,
            disabledReason: null,
          },
        ],
      },
      printerId,
      kind,
      store: {
        async readPrinter(id) {
          return {
            id,
            farmId,
            agentId,
            printerKey: 'printer',
            sandbox: true,
            state: null,
            observedAt: null,
          }
        },
      },
      inbox: {
        async queryAgentInbox(farm, agent, query, signal) {
          calls++
          assert.equal(farm, farmId)
          assert.equal(agent, agentId)
          assert.ok('assignment_id' in query)
          assert.equal(query.assignment_id, printerId)
          if (replyError) return { kind: 'error', error: replyError }
          const delivered = decodeSignallingServerFrame(
            encodeSignallingServerFrame({
              v: 1,
              t: 'connector.api-query',
              request_id: otherPrinterId,
              ...query,
            }),
          )
          assert.equal(delivered.t, 'connector.api-query')
          const response = await answerApiQuery(
            delivered,
            async () => source,
            signal!,
          )
          const reply = decodeSignallingClientFrame(
            encodeSignallingClientFrame(response),
          )
          assert.equal(reply.t, 'connector.api-query-result')
          assert.equal(reply.request_id, otherPrinterId)
          return ApiQueryResult.parse(JSON.parse(reply.wire))
        },
      },
    }
  return {
    input,
    calls: () => calls,
    request: (query = '') =>
      readIntegrationApiQuery({
        ...input,
        request: new Request(
          `https://example.test/printers/${input.printerId}/${input.kind}${query}`,
        ),
      }),
    failWith(error: typeof replyError) {
      replyError = error
    },
  }
}

test('files use live read-only listing and paginate within both item and wire limits', async () => {
  const files = Array.from({ length: 205 }, (_, i) => ({
    path: `${i}-${'文'.repeat(238)}.gcode`,
    size: 1234,
    modified: 123.25,
  }))
  const f = fixture('files', {
    files: {
      backend: 'moonraker',
      client: {
        async request(method, params) {
          assert.equal(method, 'server.files.list')
          assert.deepEqual(params, { root: 'gcodes' })
          return files
        },
      },
    },
  })
  const collected: unknown[] = []
  let cursor: string | null = null
  do {
    const response = await f.request(
      `?limit=100${cursor ? '&cursor=' + cursor : ''}`,
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('ratelimit-remaining'), '40')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const page: { data: unknown[]; nextCursor: string | null } =
      await response.json()
    assert.ok(page.data.length > 0 && page.data.length < 100)
    collected.push(...page.data)
    cursor = page.nextCursor
    assert.ok(f.calls() < 50)
  } while (cursor)
  assert.deepEqual(
    collected,
    files.slice(0, 200).map((file) => ({
      name: file.path,
      sizeBytes: 1234,
      modifiedAt: 123250,
    })),
  )
})

test('macro names use Moonraker discovery and paginate with an assignment- and kind-specific cursor', async () => {
  const f = fixture('macros', {
    macros: listMoonrakerMacros([
      'gcode_macro PARK',
      'gcode_macro CLEAN',
      'gcode_macro LOAD_FILAMENT',
      'gcode_macro PARK',
      'gcode_macro INVALID NAME',
      'toolhead',
    ]),
  })
  const first = await (await f.request('?limit=1')).json()
  assert.deepEqual(first.data, [{ name: 'CLEAN' }])
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(
    await (await f.request('?cursor=' + first.nextCursor)).json(),
    {
      data: [{ name: 'PARK' }],
      nextCursor: null,
    },
  )
  f.input.kind = 'files'
  f.input.principal = { ...f.input.principal, scopes: ['files:read'] }
  assert.equal((await f.request('?cursor=' + first.nextCursor)).status, 400)
  assert.equal(f.calls(), 2)
})

test('unsupported families and inbox failures use the documented problem codes', async () => {
  for (const f of [
    fixture('files', { files: { backend: 'creality' } }),
    fixture('files', { files: { backend: 'anycubic' } }),
    fixture('macros', undefined),
  ]) {
    const response = await f.request()
    assert.equal(response.status, 422)
    assert.equal((await response.json()).code, 'unsupported')
  }
  const f = fixture('macros', { macros: [] })
  assert.deepEqual(await (await f.request()).json(), {
    data: [],
    nextCursor: null,
  })
  for (const [code, status] of [
    ['connector-unavailable', 503],
    ['connector-timeout', 504],
  ] as const) {
    f.failWith(code)
    const response = await f.request()
    assert.equal(response.status, status)
    assert.equal((await response.json()).code, code)
  }
  f.input.inbox = undefined
  const offline = await f.request()
  assert.equal(offline.status, 503)
  assert.equal((await offline.json()).code, 'connector-unavailable')
})

test('invalid pagination, missing scope and uncovered printers never reach the inbox', async () => {
  const f = fixture('files', undefined)
  for (const query of [
    '?limit=0',
    '?limit=101',
    '?limit=1&limit=2',
    '?cursor=%%%',
    '?cursor=a&cursor=b',
  ]) {
    assert.equal((await f.request(query)).status, 400)
  }
  f.input.printerId = otherPrinterId
  assert.equal((await f.request()).status, 404)
  f.input.principal = { ...f.input.principal, scopes: ['control:extended'] }
  assert.equal((await f.request()).status, 403)
  assert.equal(f.calls(), 0)
})

test('Moonraker transport allows only the two local reads and bounds their replies', async (t) => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(init.method, undefined) // Fetch defaults to GET.
    assert.equal(init.redirect, 'error')
    requests.push(url.href)
    return new Response(
      url.pathname === '/printer/objects/list'
        ? '{"result":{"objects":[]}}'
        : ' '.repeat(257),
    )
  })
  const client = moonrakerQueryClient(
    'http://printer.local',
    {
      maxMessageBytes: 256,
      requestTimeoutMs: 1000,
      connectTimeoutMs: 1000,
      staleAfterMs: 1000,
      reconnectMinMs: 1000,
      reconnectMaxMs: 1000,
    },
    new AbortController().signal,
  )
  assert.deepEqual(await client.request('printer.objects.list'), {
    objects: [],
  })
  await assert.rejects(client.request('server.files.list'), /too large/)
  await assert.rejects(client.request('printer.gcode.script'), /Unsupported/)
  assert.deepEqual(requests, [
    'http://printer.local/printer/objects/list',
    'http://printer.local/server/files/list?root=gcodes',
  ])
})

test('OpenAPI matches the live query scopes, page shape, and problem statuses', () => {
  const spec = parse(
    readFileSync(
      new URL('../../docs/api/openapi-v1.yaml', import.meta.url),
      'utf8',
    ),
  )
  for (const [kind, schema] of [
    ['files', 'PrinterFilePage'],
    ['macros', 'MacroPage'],
  ] as const) {
    const route = spec.paths[`/printers/{printerId}/${kind}`].get
    assert.deepEqual(route.security, [
      { clientCredentials: [apiQueryScopes[kind]] },
    ])
    for (const code of [200, 400, 403, 404, 422, 503, 504])
      assert.ok(route.responses[code])
    assert.equal(
      route.responses[200].content['application/json'].schema.$ref,
      '#/components/schemas/' + schema,
    )
    assert.equal(
      spec.components.schemas[schema].allOf[1].properties.data.maxItems,
      100,
    )
  }
})
