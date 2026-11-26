// Per-vendor simulators for the journey harness. Each one starts a loopback
// simulator that is already mid-print at 25 %, builds the Connector runtime
// section (collection version, bindings, private credential files and the
// assignment) for the paired agent, and exposes scripted controls plus a
// loopback discovery probe. Nothing here touches a physical printer.
import { X509Certificate, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeAnycubic } from '../../packages/connector/src/discovery/anycubic.ts'
import { probeCreality } from '../../packages/connector/src/discovery/creality.ts'
import type { Printer } from '../../packages/connector/src/discovery/index.ts'
import { probePrinterHost } from '../../packages/connector/src/discovery/probe.ts'
import { startAnycubicCameraSim } from '../../packages/sim-tools/src/anycubic-camera-sim.ts'
import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { createAnycubicDiscoverySimulator } from '../../packages/sim-tools/src/anycubic-discovery-sim.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { startFormlabsJourneyFixture } from './formlabs-fixture.ts'
import { startSdcpFixture } from './sdcp-fixture.ts'
import {
  SDCP_JOURNEY_BOARD,
  SDCP_JOURNEY_MODEL,
  startSdcpControlFixture,
} from './sdcp-control-fixture.ts'
import { startPrusaLinkJourneyFixture } from './prusa-link-fixture.ts'
import { startStatusFixture } from './status-fixtures.ts'
import { startFlashforgeControlFixture } from './flashforge-control-fixture.ts'
import { startAnycubicResinFixture } from './anycubic-resin-fixture.ts'
import { createJourneyCameraEncoder, realFfmpeg } from './camera-encoder.ts'
import { startBambuCameraFixture } from './bambu-camera-fixture.ts'
import { startKobraBridgeSimulator } from './harness-kobralink-bridge.ts'

export type VendorName =
  | 'bambu'
  | 'creality'
  | 'anycubic'
  | 'kobralink'
  | 'sdcp'
  | 'formlabs'
  | 'prusa-link'
  | 'qidi'
  | 'flashforge'
  | 'phrozen'
  | 'halot'
  | 'anycubic-resin'

/** What a spec can do to the running simulated print. */
export type VendorControls = Readonly<{
  /** Puts the print at a whole percentage (0..99) and keeps it there. */
  setProgress(percent: number): void
  /** The print completes (the vendor's own "finished" state). */
  finishPrint(): void
  /** The print fails (the vendor's own failure state). */
  failPrint(): void
}>

export type BambuCameraScenario = 'jpeg' | 'rtsps' | 'unmapped'

export type VendorOptions = Readonly<{
  printerKey: string
  /** Optional unique device suffix when sharing a Connector with siblings. */
  deviceId?: string
  /** Bambu and Flashforge: opt in to commands. SDCP: use the control simulator. */
  control?: boolean
  /** Flashforge control only: the test-only write qualification. */
  flashforgeQualified?: boolean
  bambuCamera?: BambuCameraScenario
  /** PrusaLink only: the catalog model to simulate (default Prusa MK4). */
  printerModel?: string
  /** Bambu simulator FTPS port; zero selects an ephemeral loopback port. */
  ftpsPort?: number
  /** Bambu simulator address for its browser onboarding journey. */
  host?: string
  /**
   * Creality only: the printer advertises a secure endpoint (HTTPS `/info`
   * naming a WSS port) with a synthetic certificate that the Connector trusts
   * through its binding's `caFile`. Off by default: stock plain WebSocket.
   */
  secure?: boolean
}>

export type RuntimeScope = Readonly<{
  farmId: string
  agentId: string
  assignmentId: string
  printerKey: string
}>

/** The Connector runtime file sections this vendor needs. */
export type VendorRuntime = Readonly<{
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8
  collection: Readonly<Record<string, unknown>>
  assignment: Readonly<Record<string, unknown>>
  /**
   * Pause between telemetry drains. Telemetry, the status inbox and the
   * control inbox share one credential proof slot; a slower drain leaves the
   * slot free for the inboxes of a simulator that reports every second.
   */
  telemetryIdleMs?: number
  /** Opt-in camera section of the runtime file. */
  camera?: (assignmentId: string) => Record<string, unknown>
}>

export type VendorDiscovery = Readonly<{
  /** Loopback endpoint the discovery/probe responder listens on. */
  host: string
  port: number
  /** Secure discovery only: how the Connector's probe reaches the responder. */
  secure?: Readonly<{ https: number; caFile: string }>
  /** Plain `/info` requests the discovery responder served so far. */
  plainRequests?(): number
  /** Runs the Connector's own probe against the responder. */
  probe(): Promise<
    Printer | { vendor: 'kobralink'; host: string; port: number } | undefined
  >
}>

/** Loopback camera the Connector reads. */
export type VendorCamera = Readonly<{
  host: string
  port: number
  /** Absolute path of the encoder the Connector runs for this camera. */
  helper: string
  /** Stream requests the simulated camera served. */
  requests(): number
  activeConnections?(): number
}>

export type VendorSimulator = Readonly<{
  name: VendorName
  printerKey: string
  /** The simulator itself, for vendor-specific assertions. */
  raw: unknown
  controls: VendorControls
  /** Absent for vendors with no network discovery step (Bambu). */
  discovery: VendorDiscovery | undefined
  /** Absent for vendors whose camera is not simulated. */
  camera: VendorCamera | undefined
  runtime(scope: RuntimeScope): Promise<VendorRuntime>
  close(): Promise<void>
}>

/** Moonraker is the harness default; everything else is a VendorName. */
export const VENDOR_DESCRIPTIONS: Readonly<Record<VendorName, string>> = {
  'prusa-link': 'Loopback PrusaLink status simulator',
  qidi: 'Loopback Qidi status simulator',
  flashforge: 'Loopback Flashforge status simulator',
  phrozen: 'Loopback Phrozen status simulator',
  halot:
    'Loopback HALOT status simulator (packages/sim-tools), printing at 25 %',
  'anycubic-resin':
    'Loopback synthetic Photon P1 Max (packages/sim-tools), pinned TLS broker and FLV camera, printing at 25 %',
  formlabs: 'Loopback Formlabs PreForm status simulator',
  sdcp: 'Loopback SDCP status simulator',
  bambu:
    'Loopback Bambu LAN MQTT/TLS simulator (packages/sim-tools), pinned TLS, printing at 25 %; control commands opt-in',
  creality:
    'Loopback Creality WebSocket simulator (packages/sim-tools), printing at 25 %, 210/60 °C',
  anycubic:
    'Loopback Anycubic LAN MQTT/TLS simulator (packages/sim-tools), pinned TLS, printing at 25 %',
  kobralink:
    'Loopback KobraLink bridge stand-in (tests/journey/harness-kobralink-bridge.ts), synthetic Kobra X, printing at 25 %',
}

/**
 * LAN access code the Bambu simulator accepts. It must satisfy the production
 * form rule (6 to 32 letters and digits) so browser set-up can submit it.
 */
export const BAMBU_ACCESS_CODE = 'journeyaccess'
const MODEL_ID = '20024'

type Closer = () => Promise<void>

async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
}

function pinOf(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
}

/**
 * Synthetic self-signed certificate for the secure Creality simulator. The
 * certificate doubles as the CA file the Connector's binding trusts.
 */
async function syntheticCrealityTls(directory: string) {
  const caFile = join(directory, 'creality-ca.pem')
  const keyFile = join(directory, 'creality-key.pem')
  execFileSync(
    'openssl',
    [
      ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes'],
      ...['-keyout', keyFile, '-out', caFile, '-days', '1'],
      ...['-subj', '/CN=127.0.0.1'],
      ...['-addext', 'subjectAltName=IP:127.0.0.1'],
    ],
    { stdio: 'ignore', timeout: 15_000 },
  )
  return {
    caFile,
    material: {
      key: await readFile(keyFile, 'utf8'),
      cert: await readFile(caFile, 'utf8'),
      // The stock /info answer of the plain responder next to it.
      info: { model: 'Creality K1', mac: 'AA:BB:CC:00:00:01' },
    },
  }
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

/** Listens on the first free loopback port of an inclusive range. */
async function listeningInRange(
  server: Server,
  host: string,
  first: number,
  last: number,
) {
  for (let port = first; port <= last; port++) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? resolve(false) : reject(error)
      server.once('error', failed)
      server.listen(port, host, () => {
        server.removeListener('error', failed)
        resolve(true)
      })
    })
    if (bound) return port
  }
  throw new Error(`No free loopback port in ${first}..${last}`)
}

function closing(server: Server) {
  return () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    })
}

/** One real JPEG frame (320x240 test pattern) from the local ffmpeg. */
function testFrame(ffmpeg: string): Buffer {
  return execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=10',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ],
    { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
  )
}

/**
 * Starts the paced loopback camera and builds the Connector's camera section.
 * The encoder is the pinned offline stand-in unless the real FFmpeg
 * qualification is requested (see ./camera-encoder.ts).
 */
async function startCamera(
  kind: 'creality-mjpeg' | 'anycubic-rinkhals' | 'flashforge-mjpeg',
  undo: Closer[],
) {
  const encoder = await createJourneyCameraEncoder()
  undo.push(() => encoder.dispose())
  const { path: ffmpeg, sha256 } = encoder
  const sim = await startAnycubicCameraSim({
    // The qualification keeps the 320x240 frame from the real encoder; the
    // stand-in ignores pixels and reads the pre-encoded frame.
    jpeg: encoder.kind === 'ffmpeg' ? testFrame(ffmpeg) : encoder.frame,
    frameIntervalMs: 100,
  })
  undo.push(() => sim.close())
  const camera: VendorCamera = {
    host: sim.host,
    port: sim.port,
    helper: ffmpeg,
    requests: () => sim.requests,
  }
  const section = (assignmentId: string) => ({
    helper: { path: ffmpeg, sha256 },
    maxSessions: 1,
    cameras: [
      {
        cameraId: 'journey-camera',
        assignmentId,
        source: { kind, address: sim.host, port: sim.port },
      },
    ],
  })
  return { camera, section }
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
    let camera: VendorCamera | undefined
    let cameraSection:
      ((assignmentId: string) => Record<string, unknown>) | undefined
    let raw: unknown
    let controls: VendorControls
    let runtime: VendorSimulator['runtime']

    if (name === 'flashforge' && options.control) {
      const fixture = await startFlashforgeControlFixture({
        directory,
        model: options.printerModel ?? 'Adventurer 5M Pro',
        qualified: options.flashforgeQualified === true,
      })
      undo.push(fixture.close)
      raw = fixture
      const unsupported = () => {
        throw new Error('Flashforge journey drives the simulator directly')
      }
      controls = {
        setProgress: unsupported,
        finishPrint: unsupported,
        failPrint: unsupported,
      }
      const flashforgeCamera = await startCamera('flashforge-mjpeg', undo)
      camera = flashforgeCamera.camera
      cameraSection = flashforgeCamera.section
      runtime = async (scope) => {
        await fixture.prepareBuild()
        return {
          ...(cameraSection ? { camera: cameraSection } : {}),
          version: 8,
          collection: {
            version: 8,
            allowedOrigins: [fixture.origin],
            printers: [],
            drivers: [{ ...fixture.binding, printerKey: scope.printerKey }],
            limits: { staleAfterMs: 5000 },
          },
          assignment: { ...localAssignment(scope), backend: name },
        }
      }
    } else if (
      name === 'qidi' ||
      name === 'flashforge' ||
      name === 'phrozen' ||
      name === 'halot'
    ) {
      const fixture = await startStatusFixture(
        name,
        directory,
        options.printerModel,
      )
      undo.push(fixture.close)
      raw = fixture
      const unsupported = () => {
        throw new Error('Status journey is read-only')
      }
      controls = {
        setProgress: unsupported,
        finishPrint: unsupported,
        failPrint: unsupported,
      }
      runtime = async (scope) => ({
        version: 8,
        collection: {
          version: 8,
          allowedOrigins: [fixture.origin],
          printers: [],
          drivers: [{ ...fixture.binding, printerKey: scope.printerKey }],
          limits: { staleAfterMs: 5000 },
        },
        assignment: { ...localAssignment(scope), backend: name },
      })
    } else if (name === 'anycubic-resin') {
      const fixture = await startAnycubicResinFixture()
      undo.push(fixture.close)
      raw = fixture
      const unsupported = () => {
        throw new Error('The resin journey drives its simulator directly')
      }
      controls = {
        setProgress: unsupported,
        finishPrint: unsupported,
        failPrint: unsupported,
      }
      runtime = async (scope) => ({
        version: 8,
        collection: {
          version: 8,
          allowedOrigins: [fixture.origin],
          printers: [],
          drivers: [{ ...fixture.binding, printerKey: scope.printerKey }],
          limits: { staleAfterMs: 5000 },
        },
        assignment: { ...localAssignment(scope), backend: name },
        camera: fixture.camera,
        // Leaves the shared credential proof slot free for both inboxes.
        telemetryIdleMs: 5000,
      })
    } else if (name === 'prusa-link') {
      const fixture = await startPrusaLinkJourneyFixture(options.printerModel)
      undo.push(fixture.close)
      raw = fixture
      const unsupported = () => {
        throw new Error('PrusaLink journey is read-only')
      }
      controls = {
        setProgress: unsupported,
        finishPrint: unsupported,
        failPrint: unsupported,
      }
      const apiKeyFile = join(directory, 'prusa-key.json')
      await privateJson(apiKeyFile, {
        origin: fixture.simulator.endpoint,
        apiKey: fixture.apiKey,
      })
      runtime = async (scope) => ({
        version: 8,
        collection: {
          version: 8,
          allowedOrigins: [fixture.simulator.endpoint],
          printers: [],
          drivers: [
            {
              family: 'prusa-link',
              printerKey: scope.printerKey,
              origin: fixture.simulator.endpoint,
              apiKeyFile,
              expect: {
                serial: fixture.serial,
                printerType: fixture.printerType,
              },
            },
          ],
          limits: { staleAfterMs: 5000 },
        },
        assignment: { ...localAssignment(scope), backend: 'prusa-link' },
      })
    } else if (name === 'formlabs') {
      const fixture = await startFormlabsJourneyFixture()
      undo.push(fixture.close)
      raw = fixture
      const unsupported = () => {
        throw new Error('Formlabs journey does not simulate print controls')
      }
      controls = {
        setProgress: unsupported,
        finishPrint: unsupported,
        failPrint: unsupported,
      }
      runtime = async (scope) => ({
        version: 7,
        collection: {
          version: 7,
          allowedOrigins: [],
          printers: [],
          formlabs: {
            printers: [
              {
                printerKey: scope.printerKey,
                host: '127.0.0.1',
                port: fixture.simulator.port,
                deviceId: fixture.deviceId,
                model: fixture.model,
              },
            ],
          },
          limits: { staleAfterMs: 5000 },
        },
        assignment: { ...localAssignment(scope), backend: 'formlabs' },
      })
    } else if (name === 'sdcp' && options.control) {
      const sim = await startSdcpControlFixture(directory)
      undo.push(() => sim.close())
      raw = sim
      controls = {
        setProgress: sim.setProgress,
        finishPrint: () => {
          throw new Error('The SDCP control journey does not finish prints')
        },
        failPrint: () => {
          throw new Error('The SDCP control journey does not fail prints')
        },
      }
      camera = {
        host: sim.host,
        port: sim.port,
        helper: sim.helper.path,
        requests: () => sim.commands().filter(({ cmd }) => cmd === 386).length,
      }
      cameraSection = (assignmentId) => ({
        helper: sim.helper,
        maxSessions: 1,
        cameras: [
          {
            cameraId: 'journey-sdcp-camera',
            assignmentId,
            source: {
              kind: 'sdcp-rtsp',
              address: sim.host,
              mainboardId: SDCP_JOURNEY_BOARD,
              model: SDCP_JOURNEY_MODEL,
            },
          },
        ],
      })
      runtime = async (scope) => ({
        version: 6,
        collection: {
          version: 6,
          allowedOrigins: [],
          printers: [],
          sdcp: {
            printers: [
              {
                printerKey: scope.printerKey,
                host: sim.host,
                mainboardId: SDCP_JOURNEY_BOARD,
                model: SDCP_JOURNEY_MODEL,
              },
            ],
          },
          limits: { staleAfterMs: 5000 },
        },
        assignment: { ...localAssignment(scope), backend: 'sdcp' },
        // Leaves the credential proof slot free for the control inbox.
        telemetryIdleMs: 3000,
        camera: cameraSection!,
      })
    } else if (name === 'sdcp') {
      const sim = await startSdcpFixture()
      undo.push(() => sim.close())
      raw = sim
      controls = {
        setProgress: sim.setProgress,
        finishPrint: () => sim.setProgress(100),
        failPrint: () => sim.setOnline(false),
      }
      runtime = async (scope) => ({
        version: 6,
        collection: {
          version: 6,
          allowedOrigins: [],
          printers: [],
          sdcp: {
            printers: [
              {
                printerKey: scope.printerKey,
                host: '127.0.0.1',
                mainboardId: 'journey01',
                model: 'Saturn 4 Ultra',
              },
            ],
          },
          limits: { staleAfterMs: 5000 },
        },
        assignment: { ...localAssignment(scope), backend: 'sdcp' },
      })
    } else if (name === 'bambu') {
      const serial = options.deviceId
        ? `JOURNEYBAMBU_${options.deviceId}`
        : 'JOURNEYBAMBU'
      const sim = await startBambuSimulator({
        serial,
        accessCode: BAMBU_ACCESS_CODE,
        ...(options.host === undefined ? {} : { host: options.host }),
        initialState: 'RUNNING',
        // Matches the 25 % the simulator reports for the running print.
        initialLayer: 25,
        // A running print reports its nozzle target; filament changes use it.
        initialTargetTemperature: 210,
        totalLayers: 100,
        printDurationMs: 15_000,
        // State changes are reported at once; the repeated report is slow
        // enough for the Connector's telemetry queue to run empty between
        // uploads, yet well inside the binding's 5 s staleness limit. A queue
        // that never empties uploads without pause and keeps the credential
        // proof slot away from both signalling inboxes.
        reportIntervalMs: 2000,
        ...(options.ftpsPort === undefined
          ? {}
          : { ftpsPort: options.ftpsPort }),
      })
      undo.push(() => sim.close())
      raw = sim
      controls = {
        setProgress: (percent) => sim.setPrintProgress(percent),
        finishPrint: () => sim.finishPrint(),
        failPrint: () => sim.failPrint(),
      }
      const model =
        options.bambuCamera === 'jpeg'
          ? 'A1'
          : options.bambuCamera === 'unmapped'
            ? 'A2L'
            : 'X1C'
      if (options.bambuCamera) {
        const encoder = await realFfmpeg()
        const ffmpeg = join(directory, 'bambu-ffmpeg')
        await copyFile(encoder.path, ffmpeg)
        await chmod(ffmpeg, 0o700)
        // The unmapped model points at a reachable fixture to prove that it
        // stays unavailable regardless of whether an endpoint can serve frames.
        const fixture = await startBambuCameraFixture({
          directory,
          accessCode: BAMBU_ACCESS_CODE,
          rtsps: options.bambuCamera === 'rtsps',
        })
        undo.push(fixture.close)
        camera = { ...fixture, helper: ffmpeg }
        cameraSection = (assignmentId) => ({
          helper: {
            path: join(directory, 'unconfigured-rtsp-ingest'),
            sha256: '0'.repeat(64),
          },
          cameras: [
            {
              cameraId: 'journey-camera',
              assignmentId,
              source: {
                kind: 'bambu-lan',
                model,
                ffmpeg: { path: ffmpeg, sha256: encoder.sha256 },
                address: fixture.host,
                port: fixture.port,
                caFile: fixture.caFile,
                credentialFile: join(directory, 'bambu-credential.json'),
              },
            },
          ],
        })
      }
      runtime = async (scope) => {
        const credentialFile = join(directory, 'bambu-credential.json')
        await privateJson(credentialFile, { accessCode: BAMBU_ACCESS_CODE })
        return {
          version: 3,
          // Uploads and signalling inboxes share one credential proof
          // slot on the server; spaced uploads leave it free for commands.
          telemetryIdleMs: 5000,
          ...(cameraSection ? { camera: cameraSection } : {}),
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
                  ftpsPort: sim.ftpsPort,
                  control: options.control === true,
                  // Locally provisioned model: opts into extended actions.
                  model,
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
      const secure = options.secure
        ? await syntheticCrealityTls(directory)
        : undefined
      const sim = await createCrealitySimulator(
        {
          state: 1,
          printProgress: 25,
          nozzleTemp: 210,
          bedTemp: 60,
          filename: 'journey.gcode',
          layer: 25,
          totalLayer: 100,
          // Stock frame field names, the ones the Connector decodes.
          printFileName: 'journey.gcode',
          TotalLayer: 100,
          speedMode: 0,
          curFeedratePct: 100,
        },
        // A started print lasts long enough for the page to show it running.
        // The status heartbeat keeps the observation current, as stock
        // firmware does while a client is connected.
        {
          durationMs: 6000,
          totalLayers: 12,
          heartbeatMs: 1000,
          gcodeDirectory: '/mnt/UDISK/printer_data/gcodes',
          ...(secure ? { secure: secure.material } : {}),
        },
      )
      undo.push(() => sim.close())
      raw = sim
      controls = {
        setProgress: (percent) =>
          sim.setFrame({ state: 1, err: 0, printProgress: percent }),
        finishPrint: () => sim.setFrame({ state: 0, printProgress: 100 }),
        failPrint: () => sim.setFrame({ state: 0, err: 1 }),
      }
      // The Creality probe reads GET /info from the printer's HTTP port.
      let plainInfoRequests = 0
      const info = createServer((request, response) => {
        plainInfoRequests++
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
        plainRequests: () => plainInfoRequests,
        ...(secure && sim.securePort !== undefined
          ? {
              secure: { https: sim.securePort, caFile: secure.caFile },
              probe: () =>
                probeCreality('127.0.0.1', {
                  https: sim.securePort!,
                  http: infoPort,
                  caFile: secure.caFile,
                }),
            }
          : {
              probe: () =>
                probeCreality('127.0.0.1', { https: 1, http: infoPort }),
            }),
      }
      const crealityCamera = await startCamera('creality-mjpeg', undo)
      camera = crealityCamera.camera
      cameraSection = crealityCamera.section
      runtime = async (scope) => ({
        ...(cameraSection ? { camera: cameraSection } : {}),
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
                // Stock HTTP upload endpoint of the simulator.
                httpPort: sim.httpPort,
                ...(secure && sim.securePort !== undefined
                  ? {
                      // The Connector resolves the advertised WSS port from
                      // the verified HTTPS /info; no plain fallback.
                      transport: 'wss',
                      httpsPort: sim.securePort,
                      caFile: secure.caFile,
                    }
                  : {}),
              },
            ],
          },
          limits: { staleAfterMs: 5000 },
        },
        assignment: localAssignment(scope),
        telemetryIdleMs: 5000,
      })
    } else if (name === 'anycubic') {
      const deviceId = options.deviceId ?? 'JOURNEY'
      const username = 'journey-user'
      const password = 'journey-password'
      // `printerModel` selects one of the simulated models; default Kobra 3.
      const model =
        options.printerModel === '20028' || options.printerModel === '20029'
          ? options.printerModel
          : undefined
      const modelId = model ?? MODEL_ID
      const sim = await startAnycubicSimulator({
        serial: `${modelId}/${deviceId}`,
        credentials: { username, password },
        ...(model
          ? { modelId: model }
          : {
              lanFiles: { firmware: '2.4.6.7' },
              initialState: 'RUNNING' as const,
              // A started file prints for a few seconds, then completes.
              printDurationMs: 8000,
            }),
        // State changes are reported at once; the repeated report is slow
        // enough for the Connector's telemetry queue to run empty between
        // uploads. A queue that never empties uploads without pause and keeps
        // the credential proof slot away from both signalling inboxes.
        reportIntervalMs: 3000,
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
      // No camera claim for the other models.
      if (!model) {
        const anycubicCamera = await startCamera('anycubic-rinkhals', undo)
        camera = anycubicCamera.camera
        cameraSection = anycubicCamera.section
      }
      runtime = async (scope) => {
        const passwordFile = join(directory, 'anycubic-password.json')
        await privateJson(passwordFile, password)
        return {
          version: 5,
          ...(cameraSection ? { camera: cameraSection } : {}),
          // Uploads and both signalling inboxes share one credential proof
          // slot on the server; spaced uploads leave it free for commands.
          telemetryIdleMs: 5000,
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
                  ...(sim.uploadPort ? { uploadPort: sim.uploadPort } : {}),
                  modelId,
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
        id: options.deviceId
          ? `journey-kobra-${options.deviceId}`
          : 'journey-kobra',
        deviceId: options.deviceId
          ? `OPENFARM_SYNTHETIC_KOBRA_X_${options.deviceId}`
          : 'OPENFARM_SYNTHETIC_KOBRA_X_JOURNEY',
        name: 'Synthetic Kobra X',
        email: 'journey@example.test',
        password: 'journey-password',
      }
      const bridge = await startKobraBridgeSimulator(identity)
      undo.push(() => bridge.close())
      raw = bridge
      // The scripted steps keep the file the bridge is printing.
      const printing = () =>
        bridge.state.filename ? { filename: bridge.state.filename } : {}
      controls = {
        setProgress: (percent) =>
          bridge.setState({
            ...printing(),
            printState: 'printing',
            progress: percent / 100,
          }),
        finishPrint: () =>
          bridge.setState({
            ...printing(),
            printState: 'complete',
            kobraState: 'finished',
            progress: 1,
            printDurationSec: 1800,
          }),
        failPrint: () =>
          bridge.setState({
            ...printing(),
            printState: 'error',
            kobraState: 'failed',
            progress: bridge.state.progress,
          }),
      }
      // The Connector's host probe finds a KobraLink bridge by its Moonraker-
      // compatible /server/info on ports 7125, 80 and 7126..7140. This
      // responder answers on the first free port of that range.
      const info = createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/server/info') {
          response.writeHead(404).end()
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            result: { moonraker_version: 'kobralink-journey' },
          }),
        )
      })
      // IPv6 loopback: other simulators on this machine listen on 127.0.0.1,
      // and the probe reports only the first port that answers.
      const probeHost = '::1'
      const infoPort = await listeningInRange(info, probeHost, 7126, 7140)
      undo.push(closing(info))
      discovery = {
        host: probeHost,
        port: infoPort,
        probe: async () => {
          const found = await probePrinterHost(probeHost, { timeoutMs: 1500 })
          // Another journey on this machine may hold a lower port of the
          // same range, so any bridge-hinted answer counts.
          return found?.hint
            ? { vendor: 'kobralink', host: found.host, port: found.port }
            : undefined
        },
      }
      runtime = async (scope) => {
        const bridgeInstance = options.deviceId
          ? `journey-bridge-${options.deviceId}`
          : 'journey-bridge'
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
      camera,
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
