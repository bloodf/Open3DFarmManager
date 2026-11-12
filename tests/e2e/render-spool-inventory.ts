import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The status channel cannot be driven from the mocked-HTTP spec, so the real
// SpoolInventory.vue is compiled and server-rendered here with fixed props.
const app = resolve(import.meta.dirname, '../../apps/farm')
const file = join(app, 'app/components/SpoolInventory.vue')
type Descriptor = { styles: { content: string }[] }
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc') as {
  parse(
    source: string,
    options: { filename: string },
  ): { descriptor: Descriptor }
  compileScript(
    descriptor: Descriptor,
    options: { id: string; inlineTemplate: boolean },
  ): { content: string }
}

export async function renderSpoolInventory(props: Record<string, unknown>) {
  const { descriptor } = sfc.parse(readFileSync(file, 'utf8'), {
    filename: file,
  })
  const script = sfc.compileScript(descriptor, {
    id: 'spool-inventory',
    inlineTemplate: true,
  })
  const entry = `${script.content.replace('export default', 'const __component =')}
import { createSSRApp as __create } from 'vue'
import { renderToString as __render } from 'vue/server-renderer'
export const render = (props) => __render(__create(__component, props))`
  const bundled = await build({
    stdin: {
      contents: entry,
      loader: 'ts',
      resolveDir: join(app, 'app/components'),
      sourcefile: file,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    nodePaths: [join(app, 'node_modules')],
  })
  const dir = mkdtempSync(join(tmpdir(), 'o3dfm-spool-'))
  try {
    const out = join(dir, 'component.mjs')
    writeFileSync(out, bundled.outputFiles[0]!.text)
    const module = (await import(pathToFileURL(out).href)) as {
      render(props: Record<string, unknown>): Promise<string>
    }
    return {
      html: await module.render(props),
      css: descriptor.styles.map((style) => style.content).join('\n'),
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
}
