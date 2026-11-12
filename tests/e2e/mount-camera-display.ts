import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// The authenticated RTC feed cannot be driven from the mocked-HTTP spec, so the
// real CameraDisplay.vue is compiled for the browser and mounted with a stub
// MediaStream. window.cameraDisplay.{mount,unmount} drive it from the test.
const app = resolve(import.meta.dirname, '../../apps/farm')
const file = join(app, 'app/components/CameraDisplay.vue')
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc') as {
  parse(
    source: string,
    options: { filename: string },
  ): { descriptor: { styles: { content: string }[] } }
  compileScript(
    descriptor: unknown,
    options: { id: string; inlineTemplate: boolean },
  ): { content: string }
}

export async function cameraDisplayBundle() {
  const { descriptor } = sfc.parse(readFileSync(file, 'utf8'), {
    filename: file,
  })
  const script = sfc.compileScript(descriptor, {
    id: 'camera-display',
    inlineTemplate: true,
  })
  const entry = `${script.content.replace('export default', 'const __component =')}
import { createApp as __create, h as __h, shallowRef as __ref } from 'vue'
let __app
const __stream = __ref(null)
window.cameraDisplay = {
  mount(element, printerName) {
    __app = __create({ render: () => __h(__component, { stream: __stream.value, printerName }) })
    __app.mount(element)
  },
  setStream(stream) { __stream.value = stream },
  unmount() { __app?.unmount(); __app = undefined },
}`
  const bundled = await build({
    stdin: {
      contents: entry,
      loader: 'ts',
      resolveDir: join(app, 'app/components'),
      sourcefile: file,
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
  return {
    js: bundled.outputFiles[0]!.text,
    css: descriptor.styles.map((style) => style.content).join('\n'),
  }
}
