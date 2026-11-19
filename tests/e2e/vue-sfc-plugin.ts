import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from 'esbuild'

const app = resolve(import.meta.dirname, '../../apps/farm')
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc')

// Compiles one SFC to a module whose default export is the component.
export function compileVueSfc(text: string, filename: string): string {
  const { descriptor, errors } = sfc.parse(text, { filename })
  if (errors.length) throw errors[0]
  if (!descriptor.script && !descriptor.scriptSetup) {
    // Template-only components (Skeleton).
    const template = sfc.compileTemplate({
      filename,
      id: filename,
      source: descriptor.template?.content ?? '',
    })
    if (template.errors.length) throw template.errors[0]
    return `${template.code}\nexport default { render }`
  }
  return sfc.compileScript(descriptor, { id: filename, inlineTemplate: true })
    .content
}

// Lets fixture bundles import child components such as ui/Button.vue.
export const vueSfcPlugin: Plugin = {
  name: 'vue-sfc',
  setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
      contents: compileVueSfc(readFileSync(path, 'utf8'), path),
      loader: 'ts',
      resolveDir: dirname(path),
    }))
  },
}
