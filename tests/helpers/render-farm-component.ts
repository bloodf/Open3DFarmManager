import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createSSRApp, h, shallowRef, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, parse } from 'vue/compiler-sfc'

/**
 * The directory the components of the farm interface live in.
 */
const componentDir = new URL(
  '../../apps/farm/app/components/farm/',
  import.meta.url,
)

/**
 * The Vue runtime of the application, resolved from this module so the
 * compiled component loads the same runtime the page uses.
 */
const vueEntry = pathToFileURL(
  createRequire(import.meta.url).resolve('vue'),
).href

/**
 * Compiles a single-file component and renders it to HTML.
 *
 * The component under test is the one the page ships, not a copy of it: the
 * script and the template are compiled exactly as the application build
 * compiles them, and the result is rendered by the Vue server renderer.
 *
 * The compiled module is written to a temporary directory, never to the source
 * tree. Its relative imports are rewritten to absolute file URLs so they
 * resolve to the same modules the application uses.
 */
export async function renderFarmComponent(
  file: string,
  props: Record<string, unknown>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'farm-component-'))
  try {
    const target = await compileComponent(
      new URL(file, componentDir),
      directory,
      new Map(),
    )
    const module = await import(target)
    const app = createSSRApp({
      render: () => h(module.default as Component, props),
    })
    return await renderToString(app)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Compiles one component into the temporary directory and returns the path of
 * the compiled module. Child components it imports are compiled the same way,
 * once each, so a page-level component renders with its real children.
 */
async function compileComponent(
  url: URL,
  directory: string,
  compiled: Map<string, Promise<string>>,
): Promise<string> {
  const cached = compiled.get(url.href)
  if (cached) return cached
  const id = compiled.size
  const job = (async () => {
    const source = await readFile(url, 'utf8')
    const { descriptor, errors } = parse(source, { filename: url.pathname })
    if (errors.length) throw new Error(`Invalid component ${url.pathname}`)
    // The inline template keeps the script bindings visible to the render
    // function, exactly as the application build compiles this component.
    const script = compileScript(descriptor, {
      id: 'farm-component',
      inlineTemplate: true,
    })
    const children = new Map<string, string>()
    for (const [, specifier] of script.content.matchAll(
      /from ['"](\.[^'"]*\.vue)['"]/g,
    )) {
      const child = new URL(specifier!, url)
      children.set(
        child.href,
        await compileComponent(child, directory, compiled),
      )
    }
    const target = join(directory, `component-${id}.ts`)
    await writeFile(
      target,
      rewriteImports(script.content, url, children),
      'utf8',
    )
    return target
  })()
  compiled.set(url.href, job)
  return job
}

/**
 * Rewrites the imports of the compiled script to absolute file URLs: the
 * relative ones resolve to the same modules the application uses, and the bare
 * `vue` imports keep resolving to the application dependency.
 */
function rewriteImports(
  code: string,
  base: URL,
  children: ReadonlyMap<string, string>,
): string {
  const resolve = (_match: string, specifier: string) => {
    const url = new URL(specifier, base)
    const child = children.get(url.href)
    return `from '${child ? pathToFileURL(child).href : url.href}'`
  }
  return code
    .replace(/from '(\.[^']*)'/g, resolve)
    .replace(/from "(\.[^"]*)"/g, resolve)
    .replace(/from ['"]vue['"]/g, () => `from '${vueEntry}'`)
}
