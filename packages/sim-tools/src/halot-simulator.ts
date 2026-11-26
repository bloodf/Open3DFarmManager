/**
 * Loopback stand-in for the HALOT LAN WebSocket in docs/protocols/halot.md.
 * Built from public client sources, not a hardware capture: state transitions
 * are synthetic and prove nothing about a printer.
 */
import { once } from 'node:events'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'

const require = createRequire(
  new URL('../../connector/package.json', import.meta.url),
)
const { WebSocketServer } = require('ws') as typeof import('ws')

/**
 * Published reference pair, not computed here, so the Connector's token code is
 * checked against it: ResinDeck core/tests/test_halot.cpp @ a00595a (MIT),
 * password `secret1`, 8-byte form.
 */
export const HALOT_SIMULATOR_PASSWORD = 'secret1'
export const HALOT_SIMULATOR_TOKEN = 'Qxbcqf3F4ag='

export type HalotSimulatorFault =
  /** Drops every socket, and each new one on its first frame. */
  | 'disconnect'
  /** Answers nothing. */
  | 'timeout'
  /** Answers status with a frame that is not JSON. */
  | 'malformed'
  /** Acknowledges print commands without applying them. */
  | 'ignore'
  /** Applies a print command, then drops the socket before any reply. */
  | 'drop-after-command'

export async function startHalotSimulator(
  options: {
    /** The only token accepted. */
    token?: string
    version?: string
    /** The word a pause leads to; sources record both (see the protocol note). */
    pauseWord?: 'PRINT_PAUSE' | 'PRINT_STOP'
    /** The word a stop leads to; `PRINT_STOP` is how one source reads it. */
    stopWord?: 'PRINT_END' | 'PRINT_STOP' | 'TEST_CANCELLED'
    port?: number
  } = {},
) {
  const token = options.token ?? HALOT_SIMULATOR_TOKEN
  const pauseWord = options.pauseWord ?? 'PRINT_PAUSE'
  const stopWord = options.stopWord ?? 'PRINT_END'
  const machine = {
    printStatus: 'PRINT_GENERAL',
    filename: '',
    curSliceLayer: 0,
    sliceLayerCount: 0,
    printRemainTime: 0,
  }
  /** Every text command received, in order, with its token. */
  const received: { cmd: string; token?: string }[] = []
  let binaryFrames = 0
  let fault: HalotSimulatorFault | undefined

  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: options.port ?? 0,
    maxPayload: 64 * 1024,
  })
  await once(server, 'listening')

  const busy = () => machine.sliceLayerCount > 0
  const status = () => ({
    cmd: 'GET_PRINT_STATUS',
    printStatus: machine.printStatus,
    filename: machine.filename,
    curSliceLayer: busy() ? String(machine.curSliceLayer) : '',
    sliceLayerCount: busy() ? String(machine.sliceLayerCount) : '',
    printRemainTime: busy() ? String(machine.printRemainTime) : '',
    resin: '',
  })

  server.on('connection', (socket) => {
    socket.on('error', () => socket.terminate())
    socket.on('message', (data, isBinary) => {
      if (isBinary) return void binaryFrames++
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(data))
      } catch {
        return socket.close()
      }
      const cmd = String(message.cmd)
      received.push({
        cmd,
        ...(typeof message.token === 'string' ? { token: message.token } : {}),
      })
      if (fault === 'disconnect') return socket.terminate()
      if (fault === 'timeout') return
      const send = (reply: unknown) => socket.send(JSON.stringify(reply))
      if (cmd === 'VERSION_CHECK')
        return send({ version: options.version ?? '1' })
      if (cmd === 'GET_PRINT_STATUS') {
        if (fault === 'malformed') return socket.send('not json')
        return send(
          message.token === token
            ? status()
            : { cmd, printStatus: 'TOKEN_ERROR', filename: '' },
        )
      }
      if (cmd !== 'PRINT_PAUSE' && cmd !== 'PRINT_STOP') return
      if (message.token !== token) return send({ cmd, status: 'CMD_FAIL' })
      if (fault !== 'ignore') {
        const active = ['PRINT_PROCESSING', pauseWord].includes(
          machine.printStatus,
        )
        if (active && cmd === 'PRINT_STOP') machine.printStatus = stopWord
        else if (active)
          machine.printStatus =
            machine.printStatus === 'PRINT_PROCESSING'
              ? pauseWord
              : 'PRINT_PROCESSING'
      }
      if (fault === 'drop-after-command') return socket.terminate()
      send({ cmd, status: 'CMD_SUCCES' })
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    machine,
    received,
    /** Print commands and anything of an upload; empty for a read-only run. */
    writes: () =>
      received
        .map(({ cmd }) => cmd)
        .filter((cmd) => !['VERSION_CHECK', 'GET_PRINT_STATUS'].includes(cmd)),
    binaryFrames: () => binaryFrames,
    connections: () => server.clients.size,
    beginPrint(filename: string, layer = 50, total = 200) {
      Object.assign(machine, {
        printStatus: 'PRINT_PROCESSING',
        filename,
        curSliceLayer: layer,
        sliceLayerCount: total,
        printRemainTime: 2700,
      })
    },
    idle() {
      Object.assign(machine, {
        printStatus: 'PRINT_GENERAL',
        filename: '',
        curSliceLayer: 0,
        sliceLayerCount: 0,
        printRemainTime: 0,
      })
    },
    setFault(value?: HalotSimulatorFault) {
      fault = value
      if (value === 'disconnect')
        for (const socket of server.clients) socket.terminate()
    },
    async close() {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
