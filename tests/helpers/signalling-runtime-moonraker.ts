import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import type { PairingPollResponse } from '../../packages/farm-protocol/src/pairing.ts'

const Request = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.number().int().positive(),
  method: z.enum(['printer.objects.subscribe', 'printer.objects.query']),
  params: z.strictObject({
    objects: z.strictObject({
      webhooks: z.tuple([z.literal('state')]),
      print_stats: z.tuple([z.literal('state')]),
      virtual_sdcard: z.tuple([z.literal('progress')]),
    }),
  }),
})

/** Explicit finite loopback fixture. Importing does not allocate resources. */
export async function createRuntimeMoonrakerFixture() {
  if (
    process.env.SIGNALLING_HTTPS_RTC_RUNTIME !== 'yes' ||
    process.env.WS_NO_BUFFER_UTIL !== '1' ||
    process.env.WS_NO_UTF_8_VALIDATE !== '1'
  )
    throw Error('Explicit runtime fixture required')
  const directory = await mkdtemp(join(tmpdir(), 'open3dfarm-rtc-runtime-'))
  const data = join(directory, 'data')
  const identity = loadOrCreateIdentity(data)
  const controller = new AbortController()
  let running: Promise<void> | undefined,
    failure = false,
    settled = false
  let requests = 0,
    queued = 0,
    progress = 0.25,
    eventtime = 1
  let closeServer: (() => Promise<void>) | undefined
  let port = 0
  let listening = 0,
    admitted = 0,
    terminalReason: string | null = null
  let broadcast = () => {}
  let disposal: Promise<void> | undefined
  let stopPackaged: (() => Promise<void>) | undefined
  let packagedPid = 0,
    packagedSha256: string | null = null
  let packagedManifestSha256: string | null = null,
    packagedFiles = 0
  function diagnostic(value: unknown) {
    const parsed = z
      .object({
        kind: z.string().max(64),
        reason: z.string().max(80).optional(),
      })
      .parse(value)
    if (parsed.kind === 'queued') queued++
    if (parsed.kind === 'readonly-admitted') admitted++
    if (parsed.kind === 'readonly-listening') listening++
    if (parsed.kind === 'readonly-terminal')
      terminalReason = parsed.reason ?? 'unclassified'
  }
  return {
    identity,
    async start(input: {
      origin: string
      audience: string
      claim: Extract<PairingPollResponse, { status: 'approved' }>
      assignmentRefs: readonly {
        assignmentId: string
        agentId: string
        printerKey: string
      }[]
    }) {
      if (running || disposal || input.assignmentRefs.length !== 1)
        throw Error('Runtime fixture scope')
      const ref = input.assignmentRefs[0]!
      if (ref.agentId !== input.claim.agent_id)
        throw Error('Runtime fixture agent')
      const {
        WebSocketServer,
      }: typeof import('../../packages/connector/node_modules/@types/ws') =
        createRequire(
          new URL('../../packages/connector/package.json', import.meta.url),
        )('ws')
      const sockets = new WebSocketServer({
        noServer: true,
        maxPayload: 4096,
        perMessageDeflate: false,
      })
      const server = createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/server/info') {
          response.writeHead(404).end()
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            result: { klippy_connected: true, klippy_state: 'ready' },
          }),
        )
      })
      closeServer = async () => {
        for (const socket of sockets.clients) socket.terminate()
        await new Promise<void>((resolve, reject) =>
          sockets.close((error) => (error ? reject(error) : resolve())),
        )
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
      server.on('upgrade', (request, socket, head) => {
        if (request.url !== '/websocket' || sockets.clients.size !== 0) {
          socket.destroy()
          return
        }
        sockets.handleUpgrade(request, socket, head, (ws) =>
          sockets.emit('connection', ws, request),
        )
      })
      sockets.on('connection', (socket) => {
        socket.on('error', () => {
          failure = true
          socket.terminate()
        })
        socket.on('ping', () => socket.terminate())
        socket.on('pong', () => socket.terminate())
        socket.on('message', (data, binary) => {
          try {
            if (binary || ++requests > 64) throw Error('Fixture request cap')
            const request = Request.parse(
              parseBoundedJson(data.toString(), {
                maxBytes: 4096,
                maxDepth: 5,
                maxValues: 32,
                maxStringChars: 128,
              }),
            )
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  eventtime,
                  status: {
                    webhooks: { state: 'ready' },
                    print_stats: { state: 'printing' },
                    virtual_sdcard: { progress },
                  },
                },
              }),
            )
          } catch {
            failure = true
            socket.terminate()
          }
        })
      })
      broadcast = () => {
        if (progress !== 0.25) throw Error('Only one fixture transition')
        progress = 0.75
        eventtime++
        for (const socket of sockets.clients)
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notify_status_update',
              params: [{ virtual_sdcard: { progress } }, eventtime],
            }),
          )
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw Error('Fixture listener missing')
      port = address.port
      const moon = `http://127.0.0.1:${address.port}`
      const configPath = join(directory, 'runtime.json'),
        credentialPath = join(directory, 'credential.json')
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          collection: {
            version: 1,
            allowedOrigins: [moon],
            printers: [{ printerKey: ref.printerKey, origin: moon }],
            limits: { staleAfterMs: 5000 },
          },
          assignments: [
            {
              assignment_id: ref.assignmentId,
              agent_id: ref.agentId,
              farm_id: input.claim.farm_id,
              printer_key: ref.printerKey,
              moonraker_origin: moon,
            },
          ],
          telemetry: {
            endpoint: input.origin + '/api/connector/telemetry',
            audience: input.audience,
            retryMinMs: 1000,
            retryMaxMs: 1000,
          },
          signalling: {
            endpoint:
              input.origin.replace('https:', 'wss:') +
              '/api/signalling/connector',
            origin: input.origin,
            audience: input.audience,
            retryMinMs: 1000,
            retryMaxMs: 1000,
          },
        }),
        { mode: 0o600, flag: 'wx' },
      )
      await writeFile(
        credentialPath,
        JSON.stringify({
          version: 1,
          expected_fingerprint: identity.fingerprint,
          approval: input.claim,
        }),
        { mode: 0o600, flag: 'wx' },
      )
      if (process.env.SIGNALLING_HTTPS_RTC_PACKAGED === 'yes') {
        const entry = new URL(
          '../../packages/connector/dist/cli.js',
          import.meta.url,
        )
        const dist = new URL('.', entry)
        const files = (await readdir(dist, { withFileTypes: true })).sort(
          (a, b) => a.name.localeCompare(b.name, 'en'),
        )
        if (files.length > 64 || files.some((file) => !file.isFile()))
          throw Error('Packaged file bound')
        let totalBytes = 0
        const manifest = []
        for (const file of files) {
          const bytes = await readFile(new URL(file.name, dist))
          totalBytes += bytes.length
          if (bytes.length > 2 * 1024 * 1024 || totalBytes > 16 * 1024 * 1024)
            throw Error('Packaged byte bound')
          manifest.push({
            name: file.name,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          })
        }
        packagedFiles = manifest.length
        packagedManifestSha256 = createHash('sha256')
          .update(JSON.stringify(manifest))
          .digest('hex')
        packagedSha256 = createHash('sha256')
          .update(await readFile(entry))
          .digest('hex')
        const child = spawn(
          process.execPath,
          [
            entry.pathname,
            'run',
            '--config',
            configPath,
            '--credential-file',
            credentialPath,
            '--data-dir',
            data,
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_OPTIONS: '' },
          },
        )
        packagedPid = child.pid ?? 0
        let bytes = 0,
          errors = 0,
          buffer = ''
        const closed = new Promise<void>((resolve) => {
          child.once('error', () => {
            failure = true
          })
          child.once('close', (code, signal) => {
            if (code !== 0 || signal !== null || buffer.length) failure = true
            settled = true
            resolve()
          })
        })
        child.stdout.on('data', (chunk: Buffer) => {
          try {
            bytes += chunk.length
            if (
              bytes > 262144 ||
              Buffer.byteLength(buffer) + chunk.length > 16384
            )
              throw Error('Packaged output bound')
            buffer += new TextDecoder('utf-8', { fatal: true }).decode(chunk)
            let end: number
            while ((end = buffer.indexOf('\n')) >= 0) {
              diagnostic(
                parseBoundedJson(buffer.slice(0, end), {
                  maxBytes: 16384,
                  maxDepth: 4,
                  maxValues: 64,
                  maxStringChars: 256,
                }),
              )
              buffer = buffer.slice(end + 1)
            }
          } catch {
            failure = true
            child.kill('SIGTERM')
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          errors += chunk.length
          if (errors > 16384) {
            failure = true
            child.kill('SIGTERM')
          }
        })
        stopPackaged = async () => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGTERM')
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              closed,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(Error('Packaged shutdown timeout')),
                  6000,
                )
              }),
            ])
          } catch (error) {
            failure = true
            child.kill('SIGKILL')
            await closed
            throw error
          } finally {
            clearTimeout(timer)
          }
        }
        running = closed
        return
      }
      const { runConnectorAgent } =
        await import('../../packages/connector/src/runtime/agent.ts')
      running = runConnectorAgent({
        configPath,
        credentialPath,
        dataDirectory: data,
        signal: controller.signal,
        onDiagnostic: diagnostic,
      })
        .catch(() => {
          failure = true
        })
        .finally(() => {
          settled = true
        })
    },
    advance() {
      broadcast()
    },
    observe() {
      return {
        kind: 'runtime-observation' as const,
        requests,
        queued,
        failure,
        settled,
        directory,
        port,
        admitted,
        listening,
        terminalReason,
        packagedPid,
        packagedSha256,
        packagedManifestSha256,
        packagedFiles,
      }
    },
    close() {
      disposal ??= (async () => {
        controller.abort()
        const errors: unknown[] = []
        try {
          await stopPackaged?.()
        } catch (error) {
          errors.push(error)
        }
        try {
          await running
        } catch (error) {
          errors.push(error)
        }
        try {
          await closeServer?.()
        } catch (error) {
          errors.push(error)
        }
        if (errors.length || failure)
          throw Error('Runtime fixture cleanup/failure')
        await rm(directory, { recursive: true })
      })()
      return disposal
    },
  }
}
