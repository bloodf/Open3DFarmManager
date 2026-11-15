// Per-vendor simulators for the journey harness. Each one starts a loopback
// simulator that is already mid-print at 25 %, builds the Connector runtime
// section (collection version, bindings, private credential files and the
// assignment) for the paired agent, and exposes scripted controls plus a
// loopback discovery probe. Nothing here touches a physical printer.
import { X509Certificate, createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeAnycubic } from '../../packages/connector/src/discovery/anycubic.ts'
import { probeCreality } from '../../packages/connector/src/discovery/creality.ts'
import type { Printer } from '../../packages/connector/src/discovery/index.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { createAnycubicDiscoverySimulator } from '../../packages/sim-tools/src/anycubic-discovery-sim.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { startKobraBridgeSimulator } from './harness-kobralink-bridge.ts'

export type VendorName = 'bambu' | 'creality' | 'anycubic' | 'kobralink'

/** What a spec can do to the running simulated print. */
export type VendorControls = Readonly<{
  /** Puts the print at a whole percentage (0..99) and keeps it there. */
  setProgress(percent: number): void
  /** The print completes (the vendor's own "finished" state). */
  finishPrint(): void
  /** The print fails (the vendor's own failure state). */
  failPrint(): void
}>

export type VendorOptions = Readonly<{
  printerKey: string
  /** Bambu only: opt the binding in to control commands (default false). */
  control?: boolean
}>

export type RuntimeScope = Readonly<{
  farmId: string
  agentId: string
  assignmentId: string
  printerKey: string
}>

/** The Connector runtime file sections this vendor needs. */
export type VendorRuntime = Readonly<{
  version: 2 | 3 | 4 | 5
  collection: Readonly<Record<string, unknown>>
  assignment: Readonly<Record<string, unknown>>
}>

export type VendorDiscovery = Readonly<{
  /** Loopback endpoint the discovery/probe responder listens on. */
  host: string
  port: number
  /** Runs the Connector's own probe against the responder. */
  probe(): Promise<Printer | undefined>
}>

export type VendorSimulator = Readonly<{
  name: VendorName
  printerKey: string
  /** The simulator itself, for vendor-specific assertions. */
  raw: unknown
  controls: VendorControls
  /** Absent for vendors with no network discovery step (Bambu, KobraLink). */
  discovery: VendorDiscovery | undefined
  runtime(scope: RuntimeScope): Promise<VendorRuntime>
  close(): Promise<void>
}>

/** Moonraker is the harness default; everything else is a VendorName. */
export const VENDOR_DESCRIPTIONS: Readonly<Record<VendorName, string>> = {
  bambu:
    'Loopback Bambu LAN MQTT/TLS simulator (packages/sim-tools), pinned TLS, printing at 25 %; control commands opt-in',
  creality:
    'Loopback Creality WebSocket simulator (packages/sim-tools), printing at 25 %, 210/60 °C',
  anycubic:
    'Loopback Anycubic LAN MQTT/TLS simulator (packages/sim-tools), pinned TLS, printing at 25 %',
  kobralink:
    'Loopback KobraLink bridge stand-in (tests/journey/harness-kobralink-bridge.ts), synthetic Kobra X, printing at 25 %',
}

const MODEL_ID = '20024'

type Closer = () => Promise<void>

async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
}

function pinOf(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
}

function listening(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        reject(new Error('Discovery listener missing'))
      else resolve(address.port)
    })
  })
}

function closing(server: Server) {
  return () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    })
}

function localAssignment(scope: RuntimeScope) {
  return {
    assignment_id: scope.assignmentId,
    agent_id: scope.agentId,
    farm_id: scope.farmId,
    printer_key: scope.printerKey,
  }
}

export async function startVendorSimulator(
  name: VendorName,
  options: VendorOptions,
): Promise<VendorSimulator> {
  const directory = await mkdtemp(join(tmpdir(), `journey-${name}-`))
  const undo: Closer[] = [() => rm(directory, { recursive: true, force: true })]
  try {
    const { printerKey } = options
    let discovery: VendorDiscovery | undefined
    let raw: unknown
    let controls: VendorControls
    let runtime: VendorSimulator['runtime']

    if (name === 'bambu') {
      const serial = 'JOURNEYBAMBU'
      const sim = await startBambuSimulator({
        serial,
        initialState: 'RUNNING',
      })
      undo.push(() => sim.close())
      raw = sim
      controls = {
        setProgress: (percent) => sim.setPrintProgress(percent),
        finishPrint: () => sim.finishPrint(),
        failPrint: () => sim.failPrint(),
      }
      runtime = async (scope) => {
        const credentialFile = join(directory, 'bambu-credential.json')
        await privateJson(credentialFile, { accessCode: 'journey-access' })
        return {
          version: 3,
          collection: {
            version: 3,
            allowedOrigins: [],
            printers: [],
            bambu: {
              printers: [
                {
                  printerKey: scope.printerKey,
                  serial,
                  host: sim.host,
                  port: sim.port,
                  control: options.control === true,
                  credentialFile,
                  pinSha256: pinOf(sim.syntheticTrust),
                  allowedEndpoints: [{ host: sim.host, port: sim.port }],
                },
              ],
            },
            limits: { staleAfterMs: 5000 },
          },
          assignment: localAssignment(scope),
        }
      }
    } else if (name === 'creality') {
      const sim = await createCrealitySimulator({
        state: 1,
        printProgress: 25,
        nozzleTemp: 210,
        bedTemp: 60,
        filename: 'journey.gcode',
        layer: 25,
        totalLayer: 100,
      })
      undo.push(() => sim.close())
      raw = sim
      controls = {
        setProgress: (percent) =>
          sim.setFrame({ state: 1, err: 0, printProgress: percent }),
        finishPrint: () => sim.setFrame({ state: 0, printProgress: 100 }),
        failPrint: () => sim.setFrame({ state: 0, err: 1 }),
      }
      // The Creality probe reads GET /info from the printer's HTTP port.
      const info = createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/info') {
          response.writeHead(404).end()
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({ model: 'Creality K1', mac: 'AA:BB:CC:00:00:01' }),
        )
      })
      const infoPort = await listening(info)
      undo.push(closing(info))
      discovery = {
        host: '127.0.0.1',
        port: infoPort,
        probe: () => probeCreality('127.0.0.1', { https: 1, http: infoPort }),
      }
      runtime = async (scope) => ({
        version: 4,
        collection: {
          version: 4,
          allowedOrigins: [],
          printers: [],
          creality: {
            printers: [
              {
                printerKey: scope.printerKey,
                host: '127.0.0.1',
                port: sim.port,
              },
            ],
          },
          limits: { staleAfterMs: 5000 },
        },
        assignment: localAssignment(scope),
      })
    } else if (name === 'anycubic') {
      const deviceId = 'JOURNEY'
      const username = 'journey-user'
      const password = 'journey-password'
      const sim = await startAnycubicSimulator({
        serial: `${MODEL_ID}/${deviceId}`,
        credentials: { username, password },
        initialState: 'RUNNING',
      })
      undo.push(() => sim.close())
      sim.setPrintProgress(25)
      raw = sim
      controls = {
        setProgress: (percent) => sim.setPrintProgress(percent),
        finishPrint: () => sim.finishPrint(),
        failPrint: () => sim.failPrint(),
      }
      const info = createAnycubicDiscoverySimulator()
      const infoPort = await listening(info)
      undo.push(closing(info))
      discovery = {
        host: '127.0.0.1',
        port: infoPort,
        probe: () => probeAnycubic('127.0.0.1', infoPort),
      }
      runtime = async (scope) => {
        const passwordFile = join(directory, 'anycubic-password.json')
        await privateJson(passwordFile, password)
        return {
          version: 5,
          collection: {
            version: 5,
            allowedOrigins: [],
            printers: [],
            anycubic: {
              printers: [
                {
                  printerKey: scope.printerKey,
                  host: sim.host,
                  port: sim.port,
                  modelId: MODEL_ID,
                  deviceId,
                  username,
                  pinSha256: pinOf(sim.syntheticTrust),
                  passwordFile,
                },
              ],
            },
            limits: { staleAfterMs: 5000 },
          },
          assignment: localAssignment(scope),
        }
      }
    } else {
      const identity = {
        id: 'journey-kobra',
        deviceId: 'OPENFARM_SYNTHETIC_KOBRA_X_JOURNEY',
        name: 'Synthetic Kobra X',
        email: 'journey@example.test',
        password: 'journey-password',
      }
      const bridge = await startKobraBridgeSimulator(identity)
      undo.push(() => bridge.close())
      raw = bridge
      controls = {
        setProgress: (percent) =>
          bridge.setState({ printState: 'printing', progress: percent / 100 }),
        finishPrint: () =>
          bridge.setState({
            printState: 'complete',
            kobraState: 'finished',
            progress: 1,
          }),
        failPrint: () =>
          bridge.setState({
            printState: 'error',
            kobraState: 'failed',
            progress: bridge.state.progress,
          }),
      }
      runtime = async (scope) => {
        const bridgeInstance = 'journey-bridge'
        const credentialFile = join(directory, 'kobralink-credential.json')
        const binding = {
          backend: 'kobralink' as const,
          version: 2 as const,
          bridgeInstance,
          origin: bridge.origin,
          deviceId: identity.deviceId,
          id: identity.id,
          printerKey: scope.printerKey,
          revision: 1,
          credentialFile,
        }
        await privateJson(credentialFile, {
          version: 1,
          bridgeInstance,
          origin: bridge.origin,
          deviceId: identity.deviceId,
          id: identity.id,
          printerKey: scope.printerKey,
          revision: 1,
          name: identity.name,
          email: identity.email,
          password: identity.password,
        })
        return {
          version: 2,
          collection: {
            version: 2,
            allowedOrigins: [],
            printers: [],
            kobralink: { allowedOrigins: [bridge.origin], printers: [binding] },
            limits: { staleAfterMs: 5000 },
          },
          assignment: {
            ...localAssignment(scope),
            backend: 'kobralink',
            bridgeInstance,
            origin: bridge.origin,
            deviceId: identity.deviceId,
            id: identity.id,
            revision: 1,
          },
        }
      }
    }

    let closed: Promise<void> | undefined
    return Object.freeze({
      name,
      printerKey,
      raw,
      controls,
      discovery,
      runtime,
      close: () =>
        (closed ??= (async () => {
          const failures: string[] = []
          for (const step of undo.splice(0).reverse())
            try {
              await step()
            } catch (error) {
              failures.push(
                error instanceof Error ? error.message : String(error),
              )
            }
          if (failures.length)
            throw new Error('Vendor cleanup incomplete: ' + failures.join('; '))
        })()),
    })
  } catch (error) {
    for (const step of undo.splice(0).reverse()) await step().catch(() => {})
    throw error
  }
}
