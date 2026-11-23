// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCameraServer } from '../../packages/sim-cams/src/server.ts'

/** Task-owned sim-cams on an ephemeral loopback port; no Docker camera needed. */
export async function startSnapshotCamera(input: {
  workDir: string
  helper: string
  ledger(value: object): void
}) {
  const helperPath = join(input.workDir, 'snapshot-ffmpeg')
  await copyFile(input.helper, helperPath)
  await chmod(helperPath, 0o700)
  const helperSha256 = createHash('sha256')
    .update(await readFile(helperPath))
    .digest('hex')
  input.ledger({ resource: 'snapshot-encoder', path: helperPath })
  const sim = await createCameraServer()
  try {
    sim.server.listen(0, '127.0.0.1')
    await once(sim.server, 'listening')
    const address = sim.server.address()
    if (!address || typeof address === 'string')
      throw Error('Snapshot server unavailable')
    input.ledger({ resource: 'snapshot-server', port: address.port })
    return {
      env: {
        SIGNALLING_HTTPS_CAMERA: JSON.stringify({
          kind: 'moonraker-snapshot',
          helperPath,
          helperSha256,
          snapshotPort: address.port,
        }),
      },
      async stop() {
        await sim.close()
        input.ledger({ removed: 'snapshot-server' })
      },
    }
  } catch (error) {
    await sim.close()
    throw error
  }
}
