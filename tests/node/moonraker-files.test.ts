import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listMoonrakerFiles } from '../../packages/connector/src/moonraker/files.ts'

test('lists newest valid files, bounds names and tolerates missing metadata', async () => {
  const calls: Array<[string, object]> = []
  const client = {
    async request(method: string, params: object): Promise<unknown> {
      calls.push([method, params])
      if (method === 'server.files.list')
        return [
          { path: 'old.gcode', size: 3, modified: 1 },
          { path: `new\u0000${'x'.repeat(300)}`, size: 5, modified: 2 },
          { path: 'bad', size: -1, modified: 3 },
        ]
      if ('filename' in params && params.filename === 'old.gcode')
        throw Error('missing')
      return { estimated_time: 42 }
    },
  }
  const files = await listMoonrakerFiles(client, { limit: 200 })
  assert.equal(files.length, 2)
  assert.equal(files[0]?.name.length, 255)
  assert.equal(files[0]?.estimatedTime, 42)
  assert.deepEqual(files[1], { name: 'old.gcode', size: 3, modified: 1 })
  assert.deepEqual(calls[0], ['server.files.list', { root: 'gcodes' }])
})

test('limits oversized lists after sorting', async () => {
  const client = {
    async request(method: string): Promise<unknown> {
      if (method === 'server.files.list')
        return Array.from({ length: 250 }, (_, i) => ({
          path: `${i}.gcode`,
          size: i,
          modified: i,
        }))
      return {}
    },
  }
  const files = await listMoonrakerFiles(client, { limit: 500 })
  assert.equal(files.length, 200)
  assert.equal(files[0]?.name, '249.gcode')
  assert.equal(files[199]?.name, '50.gcode')
})
