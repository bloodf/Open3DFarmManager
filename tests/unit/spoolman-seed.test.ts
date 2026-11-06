import { expect, test } from 'vitest'
import { seedSpoolman } from '../../packages/sim-tools/src/spoolman.ts'
import { serveTestServer } from './serve.ts'

test('seed is repeatable, retains unrelated rows and uses returned foreign keys', async () => {
  const data: Record<string, Record<string, unknown>[]> = {
    vendor: [{ id: 1, name: null }],
    filament: [],
    spool: [{ id: 5, comment: 'unrelated' }],
  }
  let nextId = 50
  let writes = 0
  const server = await serveTestServer(async (request) => {
    const kind = new URL(request.url).pathname.split('/').at(-1)!
    const rows = data[kind]
    if (!rows) return new Response(null, { status: 404 })
    if (request.method === 'GET') return Response.json(rows)
    const body = (await request.json()) as Record<string, unknown>
    if (
      kind === 'filament' &&
      !data.vendor!.some((v) => v.id === body.vendor_id)
    )
      return new Response(null, { status: 422 })
    if (
      kind === 'spool' &&
      !data.filament!.some((f) => f.id === body.filament_id)
    )
      return new Response(null, { status: 422 })
    const entity = { ...body, id: nextId++ }
    rows.push(entity)
    writes++
    return Response.json(entity)
  })
  try {
    expect(await seedSpoolman(server.url.origin)).toEqual({
      vendors: 2,
      filaments: 4,
      spools: 6,
    })
    expect(writes).toBe(12)
    await seedSpoolman(server.url.origin)
    expect(writes).toBe(12)
    expect(data.spool![0]).toEqual({ id: 5, comment: 'unrelated' })
  } finally {
    await server.stop()
  }
})

test('seed refuses remote origins before issuing any request', async () => {
  await expect(seedSpoolman('http://192.168.1.10:7912')).rejects.toThrow(
    'loopback',
  )
})
test('seed stops after an API failure', async () => {
  let calls = 0
  const server = await serveTestServer(() => {
    calls++
    return new Response(null, { status: 503 })
  })
  try {
    await expect(seedSpoolman(server.url.origin)).rejects.toThrow('503')
    expect(calls).toBe(1)
  } finally {
    await server.stop()
  }
})
