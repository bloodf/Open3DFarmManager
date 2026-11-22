// spec-derived, not captured: https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/AppUtils.cpp#L349-L352
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { provisionCrealityPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedCrealityControl } from '../../packages/connector/src/creality/control-driver.ts'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import {
  probeCreality,
  resolveCrealityEndpoint,
} from '../../packages/connector/src/discovery/creality.ts'
import { createCrealityTelemetryClient } from '../../packages/connector/src/creality/index.ts'

describe('Creality advertised secure endpoint', () => {
  let directory: string
  let key: string
  let cert: string
  let caFile: string
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'secure-creality-test-'))
    caFile = join(directory, 'cert.pem')
    const keyFile = join(directory, 'key.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        caFile,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    )
    key = readFileSync(keyFile, 'utf8')
    cert = readFileSync(caFile, 'utf8')
  })
  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  it('connects using the port advertised over verified HTTPS', async () => {
    const sim = await createCrealitySimulator(
      { state: 1 },
      { secure: { key, cert } },
    )
    try {
      const endpoint = await resolveCrealityEndpoint({
        host: '127.0.0.1',
        port: sim.port,
        httpsPort: sim.securePort,
        caFile,
      })
      expect(endpoint).toMatchObject({ secure: true, port: sim.securePort })
      expect(
        await probeCreality('127.0.0.1', {
          https: sim.securePort!,
          http: sim.httpPort,
          caFile,
        }),
      ).toMatchObject({ port: sim.securePort, transport: 'wss' })
      let client: ReturnType<typeof createCrealityTelemetryClient> | undefined
      try {
        const report = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('telemetry timeout')),
            3000,
          )
          client = createCrealityTelemetryClient({
            host: '127.0.0.1',
            port: sim.port,
            httpsPort: sim.securePort,
            caFile,
            onError: reject,
            onTelemetry: (value) => {
              clearTimeout(timer)
              resolve(value)
            },
          })
        })
        expect(report).toMatchObject({ state: 'printing' })
        expect(sim.secureConnections).toBe(1)
      } finally {
        await client?.close()
      }
    } finally {
      await sim.close()
    }
  })

  it('uses the verified advertised endpoint for guarded control', async () => {
    const sim = await createCrealitySimulator(
      { state: 1 },
      { secure: { key, cert } },
    )
    const binding = provisionCrealityPrinter(
      {
        assignment_id: randomUUID(),
        farm_id: randomUUID(),
        agent_id: randomUUID(),
        printer_key: 'test',
      },
      {
        printerKey: 'test',
        host: '127.0.0.1',
        port: sim.port,
        httpsPort: sim.securePort,
        caFile,
      },
    )
    const control = openFixedCrealityControl({
      binding,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: () => {},
      signal: new AbortController().signal,
    })
    try {
      await control.prepare()
      expect(sim.secureConnections).toBe(1)
      expect(sim.requests).toEqual([])
    } finally {
      await control.close()
      await sim.close()
    }
  })

  it('rejects an untrusted discovery certificate without falling back', async () => {
    const sim = await createCrealitySimulator({}, { secure: { key, cert } })
    try {
      await expect(
        resolveCrealityEndpoint({
          host: '127.0.0.1',
          port: sim.port,
          httpsPort: sim.securePort,
        }),
      ).rejects.toThrow('Creality HTTPS discovery failed')
      expect(sim.secureConnections).toBe(0)
    } finally {
      await sim.close()
    }
  })

  it.each([0, 65536, 'bad', null])(
    'rejects invalid wssPort %s with a reason',
    async (wssPort) => {
      const sim = await createCrealitySimulator(
        {},
        { secure: { key, cert, info: { wssPort } } },
      )
      try {
        await expect(
          resolveCrealityEndpoint({
            host: '127.0.0.1',
            port: sim.port,
            httpsPort: sim.securePort,
            caFile,
          }),
        ).rejects.toThrow('Invalid Creality HTTPS endpoint metadata')
      } finally {
        await sim.close()
      }
    },
  )

  it('rejects an invalid video port instead of falling back to the legacy socket', async () => {
    const sim = await createCrealitySimulator(
      {},
      { secure: { key, cert, info: { videoPort: -1 } } },
    )
    try {
      await expect(
        resolveCrealityEndpoint({
          host: '127.0.0.1',
          port: sim.port,
          httpsPort: sim.securePort,
          caFile,
        }),
      ).rejects.toThrow('videoPort')
      expect(sim.secureConnections).toBe(0)
    } finally {
      await sim.close()
    }
  })

  it('retains the configured legacy WebSocket port when HTTPS is unavailable', async () => {
    const sim = await createCrealitySimulator({ state: 0 })
    try {
      const server = createServer()
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
      const closedPort = (server.address() as { port: number }).port
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const endpoint = await resolveCrealityEndpoint({
        host: '127.0.0.1',
        port: sim.port,
        httpsPort: closedPort,
      })
      expect(endpoint).toMatchObject({ secure: false, port: sim.port })
      let client: ReturnType<typeof createCrealityTelemetryClient> | undefined
      try {
        const report = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('telemetry timeout')),
            3000,
          )
          client = createCrealityTelemetryClient({
            host: '127.0.0.1',
            port: sim.port,
            httpsPort: closedPort,
            onError: reject,
            onTelemetry: (value) => {
              clearTimeout(timer)
              resolve(value)
            },
          })
        })
        expect(report).toMatchObject({ state: 'idle' })
      } finally {
        await client?.close()
      }
    } finally {
      await sim.close()
    }
  })
})
