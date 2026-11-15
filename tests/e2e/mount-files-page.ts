import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const app = resolve(import.meta.dirname, '../../apps/farm')
const file = join(app, 'app/pages/arquivos.vue')
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc')

export async function filesPageBundle() {
  let source = readFileSync(file, 'utf8')
  source = source.replace(
    "import { useFarmView } from '../composables/useFarmView.ts'",
    `
const clock = { wall: Date.now(), mono: performance.now() }
const rows = ['Supported', 'Unsupported', 'No start'].map(name => ({
  assignment: { assignmentId: name, printerKey: name, status: 'active', connectorStatus: 'approved' },
  connection: 'authenticated',
  observation: { state: { state: 'idle', observedAt: clock.wall, controls: name === 'No start' ? [] : ['start_print'] }, received: clock, historical: false, sourceClockComparable: true }
}))
function useFarmView() {
  return { state: ref({ kind: 'ready' }), ready: ref({ accountId: 'test', scope: { accountId: 'test', farmId: 'farm', viewEpoch: 1 }, farms: [{ farmId: 'farm' }], keys: { kind: 'available', selected: 'key', choices: [{ keyId: 'key' }] }, rows }), now: ref(clock), discover() {}, selectFarm() {}, selectKey() {} }
}
`,
  )
  const start = source.indexOf('async function connect(')
  const end = source.indexOf('const session = createFilesSession', start)
  if (start < 0 || end < 0) throw new Error('Files connection boundary missing')
  source =
    source.slice(0, start) +
    `
async function connect(signal: AbortSignal): Promise<any> {
  const name = row.value?.assignment.printerKey
  return {
    listFiles: async () => name === 'Unsupported' ? { ok: false, reason: 'unsupported' } : { ok: true, files: [{ name: 'cube.gcode', size: 42, modified: 0, thumbnail: 'aGVsbG8=' }] },
    sendFile: async (_offer: unknown, _file: File, abort: AbortSignal, progress: (n: number) => void) => {
      if (name === 'Unsupported') return { ok: false, reason: 'unsupported' }
      progress(2)
      return new Promise(resolve => abort.addEventListener('abort', () => resolve({ ok: false }), { once: true }))
    },
    issueControlCommand: async (action: string, args: unknown) => { (window as any).filesCommands.push({ action, args }); return 'applied' },
    close() {}, async dispose() {},
  }
}
` +
    source.slice(end)
  const { descriptor, errors } = sfc.parse(source, { filename: file })
  if (errors.length) throw errors[0]
  const script = sfc.compileScript(descriptor, {
    id: 'files-page',
    inlineTemplate: true,
  }).content
  const result = await build({
    stdin: {
      contents: `const $fetch = async () => ({ enabled: true, origin: location.origin }); const definePageMeta = () => {};
${script.replace('export default', 'const component =')}
import { createApp, h } from 'vue'
window.filesCommands = []
window.mountFilesPage = (element) => { const app = createApp(component); app.component('NuxtLayout', { render() { return h('div', this.$slots.default?.()) } }); app.component('NuxtLink', { render() { return h('a', this.$slots.default?.()) } }); app.mount(element) }`,
      loader: 'ts',
      resolveDir: join(app, 'app/pages'),
    },
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
    nodePaths: [join(app, 'node_modules')],
  })
  return result.outputFiles[0]!.text
}
