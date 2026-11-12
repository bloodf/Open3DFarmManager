import { readJson } from './body.ts'
import { z } from 'zod'
import { simulatorUrl } from './probe.ts'
import seed from '../../../infra/sim/spoolman/seed.json' with { type: 'json' }

const Entity = z.object({
  id: z.number().int().positive(),
  name: z.string().nullish(),
  comment: z.string().nullish(),
})
type Entity = z.infer<typeof Entity>
export async function seedSpoolman(origin: string) {
  const base = simulatorUrl(origin)
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(`/api/v1/${path}`, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    })
    if (!response.ok)
      throw new Error(`Spoolman ${path} returned HTTP ${response.status}`)
    return readJson(response)
  }
  const vendors = z.array(Entity).parse(await request('vendor'))
  const filaments = z.array(Entity).parse(await request('filament'))
  const spools = z
    .array(Entity)
    .parse(await request('spool?allow_archived=true'))
  async function ensure(
    kind: string,
    existing: Entity[],
    key: 'name' | 'comment',
    value: string,
    body: unknown,
  ) {
    const matches = existing.filter((entity) => entity[key] === value)
    if (matches.length > 1)
      throw new Error(`Ambiguous simulator fixture: ${value}`)
    const found = matches[0]
    if (found) return found.id
    const created = Entity.parse(await request(kind, body))
    existing.push(created)
    return created.id
  }
  const vendorIds: number[] = []
  for (const vendor of seed.vendors)
    vendorIds.push(await ensure('vendor', vendors, 'name', vendor.name, vendor))
  const filamentIds: number[] = []
  for (const { vendor, ...filament } of seed.filaments) {
    const vendorId = vendorIds[vendor]
    if (!vendorId) throw new Error('Invalid fixture vendor reference')
    filamentIds.push(
      await ensure('filament', filaments, 'name', filament.name, {
        ...filament,
        vendor_id: vendorId,
      }),
    )
  }
  for (const { filament, ...spool } of seed.spools) {
    const filamentId = filamentIds[filament]
    if (!filamentId) throw new Error('Invalid fixture filament reference')
    await ensure('spool', spools, 'comment', spool.comment, {
      ...spool,
      filament_id: filamentId,
    })
  }
  const result = z
    .array(Entity)
    .parse(await request('spool?allow_archived=true'))
  const markers = new Set(seed.spools.map((spool) => spool.comment))
  const count = result.filter(
    (spool) => spool.comment && markers.has(spool.comment),
  ).length
  if (count !== 6)
    throw new Error(`Expected 6 simulator spools, received ${count}`)
  return {
    vendors: vendorIds.length,
    filaments: filamentIds.length,
    spools: count,
  }
}
