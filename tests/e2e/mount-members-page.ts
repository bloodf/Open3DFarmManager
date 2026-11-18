import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'

const app = resolve(import.meta.dirname, '../../apps/farm')
const pages = join(app, 'app/pages')
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc')

const farmId = '11111111-1111-4111-8111-111111111111'
const adminId = 'admin-account'
const inviteId = '22222222-2222-4222-8222-222222222222'

export async function membersPageBundle() {
  const file = join(pages, 'membros.vue')
  let source = readFileSync(file, 'utf8')
  source = source.replace(
    /onMounted\(async \(\) => \{[\s\S]*?\n\}\)/,
    `onMounted(async () => {
  farms.value = [{ farmId: ${JSON.stringify(farmId)} }]
  farmId.value = ${JSON.stringify(farmId)}
  await refresh()
})`,
  )
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
        resolveDir: dirname(path),
      }))
    },
  }
  const compiled = compile(source, file)
  const result = await build({
    stdin: {
      contents: `const calls = []
const $fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ?? null })
  if (String(url).endsWith('/members') && !options.method) {
    return {
      members: [
        { accountId: 'owner-account', username: 'Dono', role: 'owner' },
        { accountId: ${JSON.stringify(adminId)}, username: 'Admin', role: 'admin' },
      ],
    }
  }
  if (String(url).endsWith('/invites') && !options.method) {
    return {
      invites: [
        {
          id: ${JSON.stringify(inviteId)},
          role: 'viewer',
          createdAt: new Date(Date.now() - 3600000).toISOString(),
          expiresAt: new Date(Date.now() + 7200000).toISOString(),
          status: 'pending',
        },
      ],
    }
  }
  if (String(url).includes('/role')) return { accountId: ${JSON.stringify(adminId)}, role: 'viewer' }
  if (String(url).includes('/remove')) return { message: 'Membro removido. As sessões dele foram encerradas.' }
  if (String(url).includes('/revoke')) return { message: 'Convite revogado.' }
  throw Object.assign(new Error('unexpected'), { statusCode: 500 })
}
window.__membersFetchCalls = calls
const definePageMeta = () => {}
${compiled.replace('export default', 'const component =')}
import { createApp, h } from 'vue'
window.mountMembersPage = (element) => {
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
