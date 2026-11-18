import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'

const app = resolve(import.meta.dirname, '../../apps/farm')
const components = join(app, 'app/components')
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc')

// Compile the production components and the farm page's actual confirmation dialog.
export async function farmControlsBundle() {
  const page = readFileSync(join(app, 'app/pages/farm.vue'), 'utf8')
  const start = page.indexOf('    <dialog\n      ref="pauseDialog"')
  const end = page.indexOf('    </dialog>', start) + '    </dialog>'.length
  if (start < 0 || end < start)
    throw new Error('Farm confirmation dialog not found')
  const dialog = page.slice(start, end)
  const entry = `<script setup lang="ts">
import { nextTick, ref } from 'vue'
import PrinterControls from './PrinterControls.vue'
import FarmExtendedControls from './FarmExtendedControls.vue'
import { actionDialogTitle, actionDialogDescription, actionButtonConfirmationLabel, type ControlAction } from '../utils/farm-control.ts'
import { extendedLabel } from '../utils/farm-control-extended.ts'
const now = { wall: Date.now(), mono: performance.now() }
const keys = { kind: 'available', selected: 'synthetic-key', choices: [] }
const rows = [
  { name: 'KobraLink', controls: [] },
  { name: 'Bambu', controls: [] },
  { name: 'Legada', controls: undefined },
  { name: 'Klipper', controls: ['pause', 'set_temperature', 'home', 'firmware_restart', 'emergency_stop'] },
].map(({name, controls}) => ({ assignment: { assignmentId: name, printerKey: name, status: 'active', connectorStatus: 'approved' }, connection: 'authenticated', observation: { state: { state: name === 'Klipper' ? 'idle' : 'printing', observedAt: now.wall, controls }, received: now, historical: false, sourceClockComparable: true } }))
const pauseDialog = ref<HTMLDialogElement | null>(null)
const pauseCancel = ref<HTMLButtonElement | null>(null)
const pauseTarget = ref<any>(null)
const pauseState = ref({ kind: 'ready' })
const pauseRemaining = 60
const pauseStatus = ''
const issued: unknown[] = []
;(window as any).farmControlsIssued = issued
async function open(row: any, action: string, args: Record<string, unknown> = {}) {
  pauseTarget.value = { printerKey: row.assignment.printerKey, action, args }
  await nextTick()
  pauseDialog.value?.showModal()
  pauseCancel.value?.focus()
}
function confirmControl() { issued.push({ ...pauseTarget.value }); closePause() }
function closePause() { pauseDialog.value?.close(); pauseTarget.value = null }
function cancelPause(event: Event) { event.preventDefault(); closePause() }
</script>
<template><div><article v-for="row in rows" :key="row.assignment.printerKey" :aria-label="row.assignment.printerKey">
<PrinterControls :row="row" :keys="keys" :control-enabled="true" :command-in-flight="false" :now="now" @action="(action) => open(row, action)" />
<FarmExtendedControls :row="row" :keys="keys" :control-enabled="true" :command-in-flight="false" :now="now" @action="(action, args) => open(row, action, args)" />
</article>${dialog}</div></template>`
  const compile = (source: string, filename: string) => {
    const { descriptor, errors } = sfc.parse(source, { filename })
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
        resolveDir: components,
      }))
    },
  }
  const script = compile(entry, join(components, 'FarmControlsFixture.vue'))
  const result = await build({
    stdin: {
      contents: `${script.replace('export default', 'const component =')}\nimport { createApp } from 'vue'; window.mountFarmControls = (element) => createApp(component).mount(element)`,
      loader: 'ts',
      resolveDir: components,
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
