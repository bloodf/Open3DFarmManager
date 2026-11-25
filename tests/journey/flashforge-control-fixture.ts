// Original synthetic Flashforge printer for the command journeys. Wire formats:
// Parallel-7/flashforge-api-docs wiki @ 885702f. No real printer is contacted.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStatefulFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'
import { flashforgeModels } from '../fixtures/flashforge/models.ts'

const DIST = fileURLToPath(
  new URL('../../packages/connector/dist', import.meta.url),
)
const SHIPPED = 'var FLASHFORGE_QUALIFIED_WRITES = Object.freeze([]);'

/**
 * The test-only qualification. The packaged Connector has no setting for it, so
 * the journey edits the build the harness has just made, and restores it.
 * Fails unless the shipped list is there exactly once and empty.
 */
async function qualifyBuild(pair: { model: string; firmware: string }) {
  const found: { path: string; source: string }[] = []
  for (const name of await readdir(DIST)) {
    if (!name.endsWith('.js')) continue
    const path = join(DIST, name)
    const source = await readFile(path, 'utf8')
    for (let n = source.split(SHIPPED).length - 1; n > 0; n--)
      found.push({ path, source })
  }
  const [chunk] = found
  if (!chunk || found.length !== 1)
    throw new Error('Shipped Flashforge qualification list not found once')
  await writeFile(
    chunk.path,
    chunk.source.replace(
      SHIPPED,
      SHIPPED.replace('[]', JSON.stringify([pair])),
    ),
  )
  return () => writeFile(chunk.path, chunk.source)
}

export async function startFlashforgeControlFixture(input: {
  directory: string
  model: string
  qualified: boolean
}) {
  const model = flashforgeModels.find((entry) => entry.name === input.model)
  if (!model) throw new Error('Unknown Flashforge journey model')
  const firmware = model.firmware[0]!
  const sim = await startStatefulFlashforgeSimulator({
    ...model,
    detail: {
      ...model.detail,
      firmwareVersion: `v${firmware}`,
      status: 'printing',
      printFileName: 'journey.gcode',
      printProgress: 0.25,
      ...(model.pid === 38
        ? {
            matlStationInfo: {
              currentSlot: 1,
              stateAction: 0,
              slotInfos: [1, 2, 3, 4].map((slotId) => ({
                slotId,
                hasFilament: true,
              })),
            },
          }
        : {}),
    },
  })
  const origin = `http://${sim.host}:${sim.port}`
  const credentialFile = join(input.directory, 'flashforge-key.json')
  await writeFile(
    credentialFile,
    JSON.stringify({
      origin,
      serialNumber: 'FIXTURE-SERIAL',
      checkCode: 'fixture01',
    }),
    { mode: 0o600 },
  )
  let restore: (() => Promise<void>) | undefined
  return {
    sim,
    origin,
    binding: {
      family: 'flashforge' as const,
      origin,
      credentialFile,
      simulated: true,
      control: true as const,
      expect: { serialNumber: 'FIXTURE-SERIAL', model: model.name },
    },
    /** Called once the harness has built the packaged Connector. */
    async prepareBuild() {
      if (input.qualified)
        restore = await qualifyBuild({ model: model.name, firmware })
    },
    async close() {
      try {
        await restore?.()
      } finally {
        await sim.close()
      }
    },
  }
}
