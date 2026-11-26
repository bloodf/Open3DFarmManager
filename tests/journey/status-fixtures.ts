import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startQidiSimulator } from '../../packages/sim-tools/src/qidi-simulator.ts'
import { startFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import qidiData from '../fixtures/qidi/moonraker.json' with { type: 'json' }
import { qidiVariant } from '../fixtures/qidi/variants.ts'
import { flashforgeModels } from '../fixtures/flashforge/models.ts'
import flashforgeData from '../fixtures/flashforge/detail.json' with { type: 'json' }
import phrozenData from '../fixtures/phrozen/synthetic-revo-14k-v153.json' with { type: 'json' }

export type StatusVendor = 'qidi' | 'flashforge' | 'phrozen'

export async function startStatusFixture(
  name: StatusVendor,
  directory: string,
  /** Provisioned model for Qidi and Flashforge. */
  model?: string,
) {
  if (name === 'qidi') {
    const data = structuredClone(qidiData)
    Object.assign(
      data.state.result.status,
      qidiVariant(model ?? 'Q1 Pro').objects,
    )
    const simulator = await startQidiSimulator({
      ...data,
      snapshot: new Uint8Array(),
    })
    const credentialFile = join(directory, 'qidi-key.json')
    await writeFile(
      credentialFile,
      JSON.stringify({ origin: simulator.origin, secret: 'fixture-key' }),
      { mode: 0o600 },
    )
    return {
      origin: simulator.origin,
      binding: {
        family: name,
        origin: simulator.origin,
        simulated: true,
        expect: { model: model ?? 'Q1 Pro', moonrakerVersion: 'v0.8.0' },
        auth: { kind: 'api-key', credentialFile },
      },
      requests: simulator.requests,
      loseConnection: () => simulator.setFault('disconnect'),
      recover: () => {
        data.state.result.status.print_stats.state = 'complete'
        simulator.setFault(undefined)
      },
      close: simulator.close,
    }
  }
  if (name === 'flashforge') {
    const variant = flashforgeModels.find(
      (entry) => entry.name === (model ?? 'Adventurer 5M Pro'),
    )
    if (!variant) throw new Error('Unknown Flashforge journey model')
    let online = true
    let status = 'printing'
    const requests: string[] = []
    const simulator = await startFlashforgeSimulator((req, res, body) => {
      requests.push(`${req.method} ${req.url}`)
      const credential = JSON.parse(body.toString())
      const authorized =
        credential.serialNumber === 'FIXTURE-SERIAL' &&
        credential.checkCode === 'FIXTURE-CODE'
      res
        .writeHead(!online ? 503 : authorized ? 200 : 401, {
          'content-type': 'application/json',
        })
        .end(
          JSON.stringify(
            online && authorized
              ? {
                  code: 0,
                  detail: {
                    ...variant.detail,
                    status,
                    printFileName: flashforgeData.detail.printFileName,
                    printProgress: flashforgeData.detail.printProgress,
                  },
                }
              : {},
          ),
        )
    }, variant.pid)
    const origin = `http://${simulator.host}:${simulator.port}`
    const credentialFile = join(directory, 'flashforge-key.json')
    await writeFile(
      credentialFile,
      JSON.stringify({
        origin,
        serialNumber: 'FIXTURE-SERIAL',
        checkCode: 'FIXTURE-CODE',
      }),
      { mode: 0o600 },
    )
    return {
      origin,
      binding: {
        family: name,
        origin,
        credentialFile,
        simulated: true,
        expect: { serialNumber: 'FIXTURE-SERIAL', model: variant.name },
      },
      requests,
      loseConnection: () => {
        online = false
      },
      recover: () => {
        status = 'ready'
        online = true
      },
      close: simulator.close,
    }
  }
  const data = structuredClone(phrozenData)
  const simulator = await startPhrozenSimulator(data)
  const origin = `ws://127.0.0.1:${simulator.wsPort}`
  return {
    origin,
    binding: {
      family: name,
      origin,
      discoveryPort: simulator.udpPort,
      simulated: true,
      expect: {
        id: data.Id,
        board: data.Data.MainboardID,
        model: 'Sonic Mighty Revo 14K',
        firmware: 'V153',
      },
    },
    requests: simulator.commands,
    loseConnection: () => simulator.setFault('disconnect'),
    recover: () => {
      // The simulator owns a copy of the fixture state.
      simulator.reset()
      simulator.setFault()
    },
    close: simulator.close,
    /** Synthetic printer, for the control journey's state assertions. */
    simulator,
  }
}
