// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { dirname, relative } from 'node:path'
import {
  BAMBU_CLOUD_FLAG,
  assertBambuCloudOff,
  isBambuCloudEnabled,
  isBambuCloudHost,
  isLoopbackHost,
  readBambuCloudPolicy,
  resolveBambuCloudEndpoint,
} from '../../packages/connector/src/bambu/cloud.ts'
import { parseBambuBinding } from '../../packages/connector/src/bambu/configuration.ts'
import { selectBambuCamera } from '../../packages/connector/src/bambu/camera.ts'
import {
  getNetworkGuardStats,
  resetNetworkGuardStats,
  startBambuMock,
  startHttpMock,
  withNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'

const root = resolve(import.meta.dirname, '../..')

test('NUXT_BAMBU_CLOUD defaults to off in runtimeConfig and process environment', () => {
  const saved = process.env.NUXT_BAMBU_CLOUD
  try {
    delete process.env.NUXT_BAMBU_CLOUD
    assert.equal(isBambuCloudEnabled(), false)
    assert.deepEqual(readBambuCloudPolicy(), { state: 'off', enabled: false })
    assert.doesNotThrow(() => assertBambuCloudOff())

    for (const falsy of [
      undefined,
      null,
      false,
      '',
      'false',
      '0',
      'off',
      {},
      { bambuCloud: false },
      { bambuCloud: { enabled: false } },
      { NUXT_BAMBU_CLOUD: 'false' },
    ]) {
      assert.equal(isBambuCloudEnabled(falsy), false)
      assert.deepEqual(readBambuCloudPolicy(falsy), {
        state: 'off',
        enabled: false,
      })
      assert.doesNotThrow(() => assertBambuCloudOff(falsy))
    }

    for (const truthy of [
      true,
      'true',
      'TRUE',
      { bambuCloud: true },
      { bambuCloud: { enabled: true } },
      { NUXT_BAMBU_CLOUD: 'true' },
    ]) {
      assert.equal(isBambuCloudEnabled(truthy), true)
      assert.deepEqual(readBambuCloudPolicy(truthy), {
        state: 'on',
        enabled: true,
      })
      assert.throws(
        () => assertBambuCloudOff(truthy),
        /Desktop offline policy violation: NUXT_BAMBU_CLOUD must be off/,
      )
    }
  } finally {
    if (saved === undefined) delete process.env.NUXT_BAMBU_CLOUD
    else process.env.NUXT_BAMBU_CLOUD = saved
  }

  const nuxtConfig = readFileSync(
    join(root, 'apps/farm/nuxt.config.ts'),
    'utf8',
  )
  assert.match(nuxtConfig, /NUXT_BAMBU_CLOUD/)
  assert.match(nuxtConfig, /bambuCloud:\s*false/)
})

test('with NUXT_BAMBU_CLOUD off, no code path resolves or contacts a Bambu cloud host', async () => {
  const dnsAttempts = []
  const outboundConnectAttempts = []
  const origLookup = dns.lookup
  const origResolve = dns.resolve
  const origNetConnect = net.Socket.prototype.connect
  const origTlsConnect = tls.connect

  dns.lookup = (hostname, ...rest) => {
    if (!isLoopbackHost(String(hostname))) {
      dnsAttempts.push(String(hostname))
    }
    return origLookup.call(dns, hostname, ...rest)
  }
  dns.resolve = (hostname, ...rest) => {
    if (!isLoopbackHost(String(hostname))) {
      dnsAttempts.push(String(hostname))
    }
    return origResolve.call(dns, hostname, ...rest)
  }
  net.Socket.prototype.connect = function (...args) {
    const first = args[0]
    const host =
      typeof first === 'object' && first !== null && 'host' in first
        ? first.host
        : typeof args[1] === 'string'
          ? args[1]
          : undefined
    if (host && !isLoopbackHost(String(host))) {
      outboundConnectAttempts.push(String(host))
    }
    return origNetConnect.apply(this, args)
  }

  try {
    resetNetworkGuardStats()
    await withNetworkGuard(async () => {
      // 1. Resolving any Bambu cloud endpoint with flag off throws before DNS or socket activity.
      for (const cloudHost of [
        'https://api.bambulab.com/v1/user-service/my/profile',
        'https://api.bambulab.cn/v1/iot-service/api/user/device',
        'mqtts://us.mqtt.bambulab.com:8883',
        'mqtts://cn.mqtt.bambulab.com:8883',
        'https://bambu.com',
      ]) {
        assert.equal(isBambuCloudHost(cloudHost), true)
        assert.throws(
          () => resolveBambuCloudEndpoint(cloudHost, { bambuCloud: false }),
          new RegExp(`${BAMBU_CLOUD_FLAG} is off by default`),
        )
      }

      // 2. Even when NUXT_BAMBU_CLOUD is enabled in E15 tests, real Bambu cloud hosts are rejected;
      //    only a loopback fake cloud on the test harness is permitted.
      for (const realHost of [
        'https://api.bambulab.com/v1/iot-service/api/user/device',
        'https://us.mqtt.bambulab.com:8883',
        'https://api.bambulab.cn',
        'https://example.com',
      ]) {
        assert.throws(
          () => resolveBambuCloudEndpoint(realHost, { bambuCloud: true }),
          /loopback fake cloud on the test harness, never the real service/,
        )
      }

      // 3. Loopback fake cloud on the harness is accepted when NUXT_BAMBU_CLOUD=true,
      //    and rejected when NUXT_BAMBU_CLOUD=false.
      const fakeCloud = await startHttpMock({
        routes: {
          '/v1/iot-service/api/user/device': (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ message: 'success', devices: [] }))
          },
        },
      })
      try {
        assert.throws(
          () =>
            resolveBambuCloudEndpoint(
              `${fakeCloud.origin}/v1/iot-service/api/user/device`,
              { bambuCloud: false },
            ),
          /NUXT_BAMBU_CLOUD is off by default/,
        )

        const resolved = resolveBambuCloudEndpoint(
          `${fakeCloud.origin}/v1/iot-service/api/user/device`,
          { bambuCloud: true },
        )
        assert.equal(resolved.hostname, '127.0.0.1')
        const response = await fetch(resolved)
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), {
          message: 'success',
          devices: [],
        })
      } finally {
        await fakeCloud.close()
      }

      // 4. Connector Bambu LAN configuration and camera selection reject Bambu cloud domains.
      for (const cloudDomain of [
        'api.bambulab.com',
        'us.mqtt.bambulab.com',
        'api.bambulab.cn',
      ]) {
        assert.throws(
          () =>
            parseBambuBinding({
              printerKey: 'bambu-1',
              serial: '01S00C123456789',
              host: cloudDomain,
              port: 8883,
              credentialFile: '/tmp/cred.json',
              pinSha256: 'ab'.repeat(32),
              allowedEndpoints: [{ host: cloudDomain, port: 8883 }],
            }),
          /Invalid Bambu binding/,
        )
        assert.throws(
          () =>
            selectBambuCamera({
              model: 'X1C',
              host: cloudDomain,
              accessCode: 'Synth3t1c',
              pinSha256: 'ab'.repeat(32),
            }),
          /Invalid Bambu camera configuration/,
        )
      }

      // 5. Loopback Bambu mock runs cleanly under network guard with zero rejected attempts.
      const bambuMock = await startBambuMock({ reuseSharedTls: true })
      try {
        assert.ok(bambuMock.ports.default > 0)
      } finally {
        await bambuMock.close()
      }
    })

    const stats = getNetworkGuardStats()
    assert.equal(stats.rejectedAttempts, 0)
    assert.deepEqual(dnsAttempts, [])
    assert.deepEqual(outboundConnectAttempts, [])
  } finally {
    dns.lookup = origLookup
    dns.resolve = origResolve
    net.Socket.prototype.connect = origNetConnect
    tls.connect = origTlsConnect
  }
})

test('Connector Bambu adapter sources contain no outbound Bambu cloud client URLs', () => {
  const bambuDir = join(root, 'packages/connector/src/bambu')
  const files = readdirSync(bambuDir).filter((name) => name.endsWith('.ts'))
  assert.ok(files.includes('cloud.ts'))

  for (const file of files) {
    if (file === 'cloud.ts') continue
    const content = readFileSync(join(bambuDir, file), 'utf8')
    assert.doesNotMatch(
      content,
      /api\.bambulab\.(?:com|cn)|mqtt\.bambulab\.(?:com|cn)/i,
      `Unexpected cloud host reference in packages/connector/src/bambu/${file}`,
    )
  }
})

test('UI hides the Bambu cloud account section when NUXT_BAMBU_CLOUD is off by default', async () => {
  const appDir = join(root, 'apps/farm')
  const contaPath = join(appDir, 'app/pages/conta.vue')
  const contaSource = readFileSync(contaPath, 'utf8')
  assert.match(contaSource, /const bambuCloudEnabled = ref\(false\)/)
  assert.match(contaSource, /v-if="bambuCloudEnabled"/)
  assert.match(contaSource, /id="bambu-cloud-account"/)

  const requireFromApp = createRequire(join(appDir, 'package.json'))
  const sfc = requireFromApp('vue/compiler-sfc')
  const { build } = createRequire(join(root, 'package.json'))('esbuild')
  const { descriptor, errors } = sfc.parse(contaSource, {
    filename: contaPath,
  })
  assert.equal(errors.length, 0)
  const compiled = sfc.compileScript(descriptor, {
    id: 'conta-bambu-cloud-off',
    inlineTemplate: true,
  })
  assert.match(compiled.content, /bambuCloudEnabled/)

  // The page imports its own vue helpers; keep only the ones the entry below
  // does not already import, so the inlined page has no duplicate bindings.
  const entryVueImports = new Set(['ref', 'nextTick', 'createSSRApp', 'h'])
  compiled.content = compiled.content.replace(
    /^import \{([^}]*)\} from 'vue'\n/m,
    (_statement, names) => {
      const extra = names
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name && !entryVueImports.has(name))
      return extra.length > 0
        ? `import { ${extra.join(', ')} } from 'vue'\n`
        : ''
    },
  )

  // The page's relative imports resolve from its own directory, and every
  // imported .vue component compiles the same way as the page.
  const contaDir = dirname(contaPath)
  const vueSfcPlugin = {
    name: 'vue-sfc',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.importer !== '<stdin>') return undefined
        return { path: resolve(contaDir, args.path) }
      })
      pluginBuild.onLoad({ filter: /\.vue$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8')
        const parsed = sfc.parse(source, { filename: args.path })
        if (parsed.errors.length > 0) {
          return {
            errors: parsed.errors.map((error) => ({
              text: String(error.message ?? error),
            })),
          }
        }
        const script = sfc.compileScript(parsed.descriptor, {
          id: `e16-362-${relative(appDir, args.path)}`,
          inlineTemplate: true,
        })
        return {
          contents: script.content,
          loader: 'ts',
          resolveDir: dirname(args.path),
        }
      })
    },
  }

  const entry = `
import { ref, nextTick, createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
const $fetch = async () => ({})
${compiled.content.replace('export default', 'const ContaPage =')}
export async function renderConta() {
  const app = createSSRApp(ContaPage)
  app.component('NuxtLink', { props: ['to'], render() { return h('a', { href: this.to }, this.$slots.default?.()) } })
  return await renderToString(app)
}
`
  const built = await build({
    stdin: { contents: entry, loader: 'ts', resolveDir: appDir },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    nodePaths: [join(appDir, 'node_modules')],
    plugins: [vueSfcPlugin],
    logLevel: 'silent',
  })
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
  )
  const html = await mod.renderConta()
  assert.match(html, /Alterar senha/)
  assert.doesNotMatch(html, /bambu-cloud-account/)
  assert.doesNotMatch(html, /Conta Bambu Cloud/)

  const docs = readFileSync(join(root, 'docs/compatibility/bambu.md'), 'utf8')
  assert.match(docs, /NUXT_BAMBU_CLOUD/)
  assert.match(docs, /desktop:check/)
  assert.match(docs, /assertBambuCloudOff/)
})
