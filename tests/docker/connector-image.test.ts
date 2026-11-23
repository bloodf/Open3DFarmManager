import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const id = `connector-test-${randomUUID().slice(0, 8)}`
const image = process.env.CONNECTOR_TEST_IMAGE || `${id}:local`
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  'image runs against Moonraker simulator and preserves identity and queue',
  { timeout: 600000 },
  async () => {
    const data = `${id}-data`,
      config = `${id}-config`,
      sim = `${id}-sim`,
      runner = `${id}-run`
    const run = (...args: string[]) =>
      docker(
        'run',
        '--rm',
        '-v',
        `${data}:/data`,
        '-v',
        `${config}:/config`,
        image,
        ...args,
      )
    const script = (code: string) =>
      docker(
        'run',
        '--rm',
        '-v',
        `${data}:/data`,
        '-v',
        `${config}:/config`,
        '--entrypoint',
        'node',
        image,
        '-e',
        code,
      )
    try {
      if (!process.env.CONNECTOR_TEST_IMAGE)
        docker(
          'build',
          '-f',
          'packages/connector/Dockerfile',
          '-t',
          image,
          root,
        )
      assert.match(run('--version'), /^\d+\.\d+\.\d+/)
      docker(
        'run',
        '--rm',
        '--entrypoint',
        'node',
        image,
        '-e',
        "import('node-datachannel').then(()=>{}).catch(e=>{console.error(e);process.exit(1)})",
      )
      const identity = JSON.parse(run('init-identity', '--data-dir', '/data'))
      assert.equal(
        JSON.parse(run('status', '--data-dir', '/data')).fingerprint,
        identity.fingerprint,
      )
      docker(
        'run',
        '-d',
        '--name',
        sim,
        '-v',
        `${root}:/src:ro`,
        '-v',
        `${data}:/data`,
        '-v',
        `${config}:/config`,
        '--entrypoint',
        'node',
        image,
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        "import {startMoonrakerMock} from '/src/packages/sim-tools/src/mocks/moonraker-mock.ts'; const m=await startMoonrakerMock(); console.log(m.origin); setInterval(()=>console.log(JSON.stringify(m.calls())),500)",
      )
      let origin = ''
      for (let n = 0; n < 100 && !origin; n++) {
        origin =
          docker('logs', sim).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] || ''
        if (!origin) await sleep(100)
      }
      assert.ok(origin, 'simulator did not start')
      const farm = randomUUID(),
        agent = randomUUID(),
        assignment = randomUUID()
      const cfg = {
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: [origin],
          printers: [{ printerKey: 'fixture-printer', origin }],
          limits: {
            connectTimeoutMs: 200,
            requestTimeoutMs: 200,
            staleAfterMs: 1000,
            reconnectMinMs: 200,
            reconnectMaxMs: 200,
          },
        },
        assignments: [
          {
            assignment_id: assignment,
            farm_id: farm,
            agent_id: agent,
            printer_key: 'fixture-printer',
            moonraker_origin: origin,
          },
        ],
        telemetry: {
          endpoint: 'https://127.0.0.1:1/api/connector/telemetry',
          audience: 'agent-fixture',
          timeoutMs: 200,
          retryMinMs: 200,
          retryMaxMs: 200,
          idleMs: 100,
        },
      }
      const credential = {
        version: 1,
        expected_fingerprint: identity.fingerprint,
        approval: {
          status: 'approved',
          agent_id: agent,
          farm_id: farm,
          device_token: 'aaa.bbb.ccc',
          expires_at: Date.now() + 600000,
        },
      }
      script(
        `const fs=require('fs'); fs.writeFileSync('/config/runtime.json', ${JSON.stringify(JSON.stringify(cfg))}, {mode:0o600}); fs.writeFileSync('/config/credential.json', ${JSON.stringify(JSON.stringify(credential))}, {mode:0o600})`,
      )
      let firstQueue = ''
      for (let cycle = 0; cycle < 2; cycle++) {
        docker(
          'run',
          '-d',
          '--name',
          runner,
          '--network',
          `container:${sim}`,
          '-v',
          `${data}:/data`,
          '-v',
          `${config}:/config`,
          image,
          'run',
          '--config',
          '/config/runtime.json',
          '--credential-file',
          '/config/credential.json',
          '--data-dir',
          '/data',
          '--status-port',
          '18347',
        )
        let ready = false
        for (let n = 0; n < 100 && !ready; n++) {
          try {
            docker(
              'exec',
              runner,
              'node',
              '-e',
              "fetch('http://127.0.0.1:18347/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
            )
            ready = true
          } catch {
            await sleep(100)
          }
        }
        assert.ok(ready, `run failed: ${docker('logs', runner)}`)
        await sleep(1500)
        docker('stop', '-t', '20', runner)
        assert.equal(
          docker('inspect', '-f', '{{.State.ExitCode}}', runner),
          '0',
        )
        docker('rm', runner)
        assert.equal(
          JSON.parse(run('status', '--data-dir', '/data')).fingerprint,
          identity.fingerprint,
        )
        const queue = script(
          "const fs=require('fs'); console.log(fs.readFileSync('/data/telemetry/telemetry.jsonl','utf8'))",
        )
        assert.ok(
          queue.length > 0,
          'queue must retain telemetry while server is offline',
        )
        if (cycle === 0) firstQueue = queue
        else
          assert.ok(
            queue.startsWith(firstQueue),
            'queued records survive recreation',
          )
      }
      assert.match(docker('logs', sim), /printer.objects.subscribe/)
    } finally {
      for (const name of [runner, sim]) {
        try {
          docker('rm', '-fv', name)
        } catch {}
      }
      for (const volume of [data, config]) {
        try {
          docker('volume', 'rm', volume)
        } catch {}
      }
      if (!process.env.CONNECTOR_TEST_IMAGE) {
        try {
          docker('image', 'rm', image)
        } catch {}
      }
    }
  },
)
