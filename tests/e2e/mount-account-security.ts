import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { compileVueSfc, vueSfcPlugin } from './vue-sfc-plugin.ts'

const app = resolve(import.meta.dirname, '../../apps/farm')
const pages = join(app, 'app/pages')

const sharedDefine = {
  'process.env.NODE_ENV': '"production"',
  __VUE_OPTIONS_API__: 'false',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
}

const fetchPreamble = `const calls = []
const $fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ?? null })
  const target = String(url)
  if (target.endsWith('/api/auth/identities') && !options.method) {
    return { google: { available: false, linked: false, canUnlink: false } }
  }
  if (target.endsWith('/api/auth/password') && options.method === 'POST') {
    const mode = window.__passwordChangeMode ?? 'success'
    if (mode === 'success') return {}
    if (mode === 'wrong-current') {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
    }
    if (mode === 'too-short') {
      throw Object.assign(new Error('bad request'), { statusCode: 400 })
    }
    throw Object.assign(new Error('unexpected'), { statusCode: 500 })
  }
  if (target.endsWith('/api/auth/logout') && options.method === 'POST') return {}
  if (target.endsWith('/api/auth/sessions/revoke') && options.method === 'POST') {
    return {}
  }
  throw Object.assign(new Error('unexpected'), { statusCode: 500 })
}
window.__accountSecurityFetchCalls = calls
window.__passwordChangeMode = 'success'
const definePageMeta = () => {}
`

function sourceWithVueImports(pageFile: string) {
  const file = join(pages, pageFile)
  let source = readFileSync(file, 'utf8')
  if (!/^import\s+.*\sfrom\s+['"]vue['"]/m.test(source)) {
    source = source.replace(
      /<script setup[^>]*>/,
      `$&\nimport { ref, onMounted, nextTick } from 'vue'`,
    )
  }
  return { file, source }
}

async function bundlePage(pageFile: string, mountName: string, extra = '') {
  const { file, source } = sourceWithVueImports(pageFile)
  const compiled = compileVueSfc(source, file)
  const result = await build({
    stdin: {
      contents: `${fetchPreamble}
${extra}
${compiled.replace('export default', 'const component =')}
import { createApp, h } from 'vue'
window.${mountName} = (element) => {
  const app = createApp(component)
  app.component('NuxtLink', {
    props: { to: { type: String, default: '/' } },
    setup(props, { slots }) {
      return () => h('a', { href: props.to }, slots.default?.())
    },
  })
  app.mount(element)
}
`,
      loader: 'ts',
      resolveDir: pages,
      sourcefile: file,
    },
    plugins: [vueSfcPlugin],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    define: sharedDefine,
    nodePaths: [join(app, '../../node_modules')],
  })
  return result.outputFiles[0]!.text
}

export async function contaPageBundle() {
  return bundlePage('conta.vue', 'mountContaPage')
}

export async function sairPageBundle() {
  const navigateStub = `window.__navigateToTarget = null
const navigateTo = async (target) => {
  window.__navigateToTarget = target
}
`
  return bundlePage('sair.vue', 'mountSairPage', navigateStub)
}
