import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'

const app = resolve(import.meta.dirname, '../../apps/farm')
const pages = join(app, 'app/pages')
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc')

// Mount the actual page script and form, replacing only network discovery and lifecycle.
export async function setupFormsBundle(revision: number | null = 1) {
  const page = readFileSync(join(pages, 'impressoras.vue'), 'utf8')
  const script = page
    .slice(0, page.indexOf('</script>'))
    .replace(
      "import { openPrinterDiscoverySession } from '../utils/printer-discovery-view-session.ts'",
      `
const openPrinterDiscoverySession = async () => ({
  discover: async (_signal, host) => {
    const printers = [{ vendor: 'moonraker', host: '192.168.1.20', port: 7125, name: 'Klipper' }, { vendor: 'bambu', host: '192.168.1.21', serial: 'ABC123', name: 'Bambu' }, { vendor: 'creality', host: '192.168.1.22', name: 'Creality' }, { vendor: 'anycubic', host: '192.168.1.23', name: 'Anycubic' }]
    return { ok: true, printers: host ? printers.filter(p => p.host === host) : printers }
  }, close() {},
})
// Nuxt auto-import outside Nuxt: no pending network adoption.
const useNetworkAdoption = () => ref(null)`,
    )
    .replace(
      /onMounted\(\(\) => \{[\s\S]*$/,
      `kobraBootstrap.value = { kind: 'ready', data: { bootstrap: { revision: ${JSON.stringify(revision)} } } }
kobraKeyId.value = 'synthetic'
kobraKeyState.value = { kind: 'available', accountId: 'synthetic', choices: [{ keyId: 'synthetic', localKey: {} }] }
kobraController = new AbortController()
</script>`,
    )
  const start = page.indexOf(
    '      <div v-if="kobraStage === \'idle\'" class="setup-columns">',
  )
  const end = page.indexOf('      <div v-if="kobraBusy"', start)
  if (start < 0 || end < 0) throw new Error('Setup form not found')
  const source = `${script}<template><main><p v-if="kobraError" ref="kobraErrorSummary" role="alert" tabindex="-1">{{ kobraError }}</p>${page.slice(start, end)}</main></template>`
  const compile = (text: string, filename: string) => {
    const { descriptor, errors } = sfc.parse(text, { filename })
    if (errors.length) throw errors[0]
    return sfc.compileScript(descriptor, { id: filename, inlineTemplate: true })
      .content
  }
  const vuePlugin: Plugin = {
    name: 'vue-sfc',
    setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compile(readFileSync(path, 'utf8'), path),
        loader: 'ts',
        resolveDir: join(path, '..'),
      }))
    },
  }
  const compiled = compile(source, join(pages, 'impressoras.vue'))
  const result = await build({
    stdin: {
      contents: `${compiled.replace('export default', 'const component =')}\nimport { createApp } from 'vue'; window.mountSetupForms = element => createApp(component).mount(element)`,
      loader: 'ts',
      resolveDir: pages,
    },
    plugins: [vuePlugin],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    nodePaths: [join(app, '../../node_modules')],
  })
  return result.outputFiles[0]!.text
}
