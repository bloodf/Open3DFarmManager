import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  probeCreality,
  resolveCrealityEndpoint,
} from '../../packages/connector/src/discovery/creality.ts'
import { runBackgroundDiscovery } from '../../packages/connector/src/runtime/background-discovery.ts'
import { DiscoveryResults } from '../../packages/farm-protocol/src/telemetry.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('secure Creality regressions', () => {
  it('reports valid rows and diagnoses malformed ones without leaking transport', async () => {
    const controller = new AbortController()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runBackgroundDiscovery({
        enabled: true,
        intervalMs: 1,
        signal: controller.signal,
        bindings: [],
        scan: async () => [
          {
            vendor: 'creality',
            host: '127.0.0.1',
            transport: 'wss',
            port: 1234,
          },
          { vendor: 'creality', host: 'invalid' },
        ],
        report: (rows) => {
          expect(DiscoveryResults.parse(rows)).toHaveLength(1)
          expect(rows[0]).not.toHaveProperty('transport')
          controller.abort()
        },
      })
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('never falls back after certificate failure, or after a secure endpoint is advertised', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secure-creality-regression-'))
    const caFile = join(dir, 'cert.pem')
    const keyFile = join(dir, 'key.pem')
    let sim: Awaited<ReturnType<typeof createCrealitySimulator>> | undefined
    try {
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
      sim = await createCrealitySimulator(
        {},
        {
          secure: {
            key: readFileSync(keyFile, 'utf8'),
            cert: readFileSync(caFile, 'utf8'),
          },
        },
      )
      const ports = { https: sim.securePort!, http: sim.httpPort }
      await expect(probeCreality('127.0.0.1', ports)).rejects.toThrow(
        'Creality HTTPS discovery failed',
      )
      await probeCreality('127.0.0.1', { ...ports, caFile })
      await sim.close()
      sim = undefined
      await expect(
        resolveCrealityEndpoint({
          host: '127.0.0.1',
          httpsPort: ports.https,
          port: 9999,
        }),
      ).rejects.toThrow('Creality HTTPS discovery failed')
      await expect(
        resolveCrealityEndpoint({
          host: '127.0.0.1',
          httpsPort: ports.https,
          port: 9999,
          caFile,
        }),
      ).rejects.toThrow('Creality HTTPS discovery failed')
      await expect(probeCreality('127.0.0.1', ports)).rejects.toThrow(
        'Creality HTTPS discovery failed',
      )
    } finally {
      await sim?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unavailable HTTPS endpoint when a CA is configured before any discovery', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await expect(
      resolveCrealityEndpoint({
        host: '127.0.0.1',
        httpsPort: port,
        port: 9999,
        caFile: '/dev/null',
      }),
    ).rejects.toThrow('Creality HTTPS discovery failed')
  })
})
