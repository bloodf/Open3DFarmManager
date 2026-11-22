// SPDX-License-Identifier: MIT
import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { build } from 'esbuild'
import {
  compileScript,
  compileStyle,
  compileTemplate,
  parse,
} from 'vue/compiler-sfc'
import { launchBrowser } from './browser'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock'

/**
 * Mounts any page of apps/farm in Chrome against an in-process API on
 * 127.0.0.1 (port 0). Nuxt auto-imports (Vue APIs, composables, utils and
 * components) are provided as globals, so one bundle serves every page.
 */
const root = process.cwd()
const appDir = join(root, 'apps/farm/app')

export type RouteReply = {
  status?: number
  body?: unknown
  /** Milliseconds before the reply, to hold the page in its loading state. */
  delayMs?: number
  /** Never answer: the request hangs until the page gives up. */
  hang?: boolean
}
export type RouteHandler =
  | RouteReply
  | ((call: { url: URL; body: unknown; count: number }) => RouteReply)
/** Keys are `METHOD /path` (query ignored). Unlisted routes answer 404. */
export type Routes = Record<string, RouteHandler>

export type PageRoute = {
  path?: string
  query?: Record<string, string>
  params?: Record<string, string>
}

export const reply = (body: unknown, status = 200): RouteReply => ({
  status,
  body,
})
/** A server failure whose body must never reach the user. */
export const rawFailure = (status = 500): RouteReply => ({
  status,
  body: {
    statusCode: status,
    statusMessage: 'Internal Server Error',
    message:
      'TypeError: boom at /srv/app/server.js:42:7 (ECONNREFUSED 10.0.0.5:5432)',
    stack: 'TypeError: boom\n    at /srv/app/server.js:42:7',
  },
})

/** What would give away a raw error, a stack or an unfilled value. */
export const RAW_ERROR =
  /(TypeError|ReferenceError|FetchError|ofetch|ECONN\w*|ETIMEDOUT|\bat \S+\.(js|ts|vue):\d+|\[object|\bundefined\b|\bNaN\b|statusCode|statusMessage|Internal Server Error|server\.js|\b50[0-4]\b)/i

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith('.vue')
        ? [join(dir, entry.name)]
        : [],
  )

/** Nuxt component name: directory prefix + file name, joined without repeats. */
function componentName(file: string) {
  const parts = relative(join(appDir, 'components'), file)
    .replace(/\.vue$/, '')
    .split('/')
  const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  return parts.reduce(
    (name, part) =>
      pascal(part).startsWith(name) ? pascal(part) : name + pascal(part),
    '',
  )
}

const pageFiles = walk(join(appDir, 'pages'))
export const pageNames = pageFiles.map((f) =>
  relative(join(appDir, 'pages'), f).replace(/\.vue$/, ''),
)

function entrySource() {
  const modules = ['composables', 'utils'].flatMap((dir) =>
    readdirSync(join(appDir, dir))
      .filter((f) => /\.ts$/.test(f) && !/\.test\./.test(f))
      .map((f) => join(appDir, dir, f)),
  )
  const components = walk(join(appDir, 'components'))
  return `
    import * as vue from 'vue'
    import { createApp, defineComponent, h, reactive } from 'vue'
    ${modules.map((m, i) => `import * as m${i} from ${JSON.stringify(m)}`).join('\n')}
    ${components.map((c, i) => `import c${i} from ${JSON.stringify(c)}`).join('\n')}
    ${pageFiles.map((p, i) => `import p${i} from ${JSON.stringify(p)}`).join('\n')}
    import ${JSON.stringify(join(appDir, 'assets/css/main.css'))}

    const state = { navigated: [], route: reactive({ path: '/', query: {}, params: {} }) }
    const shared = new Map()
    const globals = {
      useRoute: () => state.route,
      useRouter: () => ({ push: async (to) => void state.navigated.push(to), replace: async (to) => void state.navigated.push(to) }),
      navigateTo: async (to) => void state.navigated.push(to),
      definePageMeta: () => {},
      // Nuxt's shared state: one ref per key for the life of the page.
      useState: (key, init) => (shared.get(key) ?? (shared.set(key, vue.ref(init ? init() : undefined)), shared.get(key))),
      useHead: () => {},
      onBeforeRouteLeave: () => {},
      onBeforeRouteUpdate: () => {},
    }
    for (const [key, value] of Object.entries(vue)) if (/^[a-z]/.test(key) && key !== 'version') globalThis[key] ??= value
    for (const mod of [${modules.map((_, i) => `m${i}`).join(', ')}]) for (const [key, value] of Object.entries(mod)) if (/^[a-z]/.test(key)) globalThis[key] ??= value
    Object.assign(globalThis, globals)
    // The part of ofetch the pages use; failures carry statusCode like Nuxt's.
    globalThis.$fetch = async (url, o = {}) => {
      const q = o.query ? '?' + new URLSearchParams(o.query) : ''
      const controller = new AbortController()
      const timer = o.timeout ? setTimeout(() => controller.abort(), o.timeout) : undefined
      o.signal?.addEventListener('abort', () => controller.abort())
      try {
        const response = await fetch(url + q, {
          method: o.method ?? 'GET',
          headers: o.body ? { 'content-type': 'application/json' } : {},
          body: o.body ? JSON.stringify(o.body) : undefined,
          signal: controller.signal,
        })
        const data = await response.json().catch(() => undefined)
        if (!response.ok) throw Object.assign(new Error('http'), { data, statusCode: response.status, statusMessage: response.statusText })
        return data
      } finally {
        clearTimeout(timer)
      }
    }
    const NuxtLink = defineComponent({
      props: { to: { type: [String, Object], default: '/' } },
      setup: (props, { slots }) => () => h('a', { href: typeof props.to === 'string' ? props.to : props.to.path }, slots.default?.()),
    })
    const components = { ${components.map((c, i) => `${JSON.stringify(componentName(c))}: c${i}`).join(', ')} }
    const pages = { ${pageNames.map((p, i) => `${JSON.stringify(p)}: p${i}`).join(', ')} }
    window.__mount = (name, route = {}) => {
      Object.assign(state.route, { path: '/', query: {}, params: {} }, route)
      const app = createApp(pages[name])
      app.component('NuxtLink', NuxtLink)
      for (const [key, value] of Object.entries(components)) app.component(key, value)
      app.mount('#app')
    }
    window.__navigated = () => state.navigated
  `
}

async function bundle(replace: Readonly<Record<string, string>>) {
  const result = await build({
    stdin: { contents: entrySource(), resolveDir: root, loader: 'js' },
    bundle: true,
    write: false,
    outdir: 'out',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    plugins: [
      {
        // A test may stand in for one module (e.g. a live WebRTC session).
        name: 'module-replacement',
        setup(b) {
          b.onResolve({ filter: /\.ts$/ }, (args) => {
            const target = replace[resolve(args.resolveDir, args.path)]
            return target ? { path: target } : undefined
          })
        },
      },
      {
        // Pages that import vue-router get the harness route, not a router.
        name: 'vue-router-shim',
        setup(b) {
          b.onResolve({ filter: /^vue-router$/ }, () => ({
            path: 'vue-router',
            namespace: 'router-shim',
          }))
          b.onLoad({ filter: /.*/, namespace: 'router-shim' }, () => ({
            loader: 'js',
            contents:
              'export const useRoute = () => globalThis.useRoute()\nexport const useRouter = () => globalThis.useRouter()\nexport const onBeforeRouteLeave = () => {}\nexport const onBeforeRouteUpdate = () => {}',
          }))
        },
      },
      {
        name: 'vue-sfc',
        setup(b) {
          b.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const source = await readFile(path, 'utf8')
            const { descriptor, errors } = parse(source, { filename: path })
            if (errors.length) throw new Error(errors.join('\n'))
            const id = `data-v-${basename(path, '.vue')}`
            let code: string
            if (descriptor.scriptSetup) {
              code = compileScript(descriptor, {
                id,
                inlineTemplate: true,
                genDefaultAs: 'component',
              }).content
            } else if (descriptor.script) {
              code = compileScript(descriptor, {
                id,
                genDefaultAs: 'component',
              }).content
            } else {
              const template = compileTemplate({
                filename: path,
                id,
                source: descriptor.template?.content ?? '',
              })
              if (template.errors.length)
                throw new Error(template.errors.join('\n'))
              code = `${template.code}\nconst component = { render }`
            }
            const css = descriptor.styles
              .map(
                ({ content, scoped }) =>
                  compileStyle({
                    filename: path,
                    id,
                    source: content,
                    scoped: Boolean(scoped),
                  }).code,
              )
              .join('\n')
            return {
              loader: 'ts',
              resolveDir: dirname(path),
              contents: `${code}
              component.__scopeId = ${JSON.stringify(id)}
              if (typeof document !== 'undefined') {
                const style = document.createElement('style')
                style.textContent = ${JSON.stringify(css)}
                document.head.append(style)
              }
              export default component`,
            }
          })
        },
      },
    ],
  })
  const text = (ext: string) =>
    result.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? ''
  return { js: text('.js'), css: text('.css') }
}

const shell = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Página</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>`

export type OpenOptions = {
  route?: PageRoute
  /** Install a fake clock so polling and stale ages can be fast-forwarded. */
  clock?: boolean
  /** Script run in the page before the app starts, e.g. to seed a stand-in module. */
  init?: string
  width?: number
}

export type PageHarness = {
  /** Mounts `pageName` against `routes`; returns the page and its call log. */
  open: (
    pageName: string,
    routes?: Routes,
    options?: OpenOptions,
  ) => Promise<{
    page: Page
    calls: (method: string, fragment: string) => number
    navigated: () => Promise<unknown[]>
    /** Replaces the route table while the page stays open. */
    setRoutes: (next: Routes) => void
    close: () => Promise<void>
  }>
  close: () => Promise<void>
}

export type HarnessOptions = {
  /** Absolute module path -> absolute path of the module that replaces it. */
  replace?: Readonly<Record<string, string>>
}

export async function createPageHarness(
  options: HarnessOptions = {},
): Promise<PageHarness> {
  const assets = await bundle(options.replace ?? {})
  const browser: Browser = await launchBrowser({
    args: ['--disable-background-networking'],
  })
  const open: PageHarness['open'] = async (
    pageName,
    routes = {},
    options = {},
  ) => {
    let table = routes
    const counts = new Map<string, number>()
    const server = await startHttpMock({
      port: 0,
      handler: async (
        req: IncomingMessage,
        res: ServerResponse,
        body: Buffer,
      ) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (url.pathname === '/') {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          return void res.end(shell)
        }
        const key = `${req.method} ${url.pathname}`
        const count = (counts.get(key) ?? 0) + 1
        counts.set(key, count)
        const handler = table[key]
        let parsed: unknown
        try {
          parsed = body.length ? JSON.parse(body.toString()) : undefined
        } catch {
          parsed = undefined
        }
        const answer: RouteReply = handler
          ? typeof handler === 'function'
            ? handler({ url, body: parsed, count })
            : handler
          : { status: 404, body: { message: 'não encontrado' } }
        if (answer.hang) return
        if (answer.delayMs)
          await new Promise((r) => setTimeout(r, answer.delayMs))
        res.statusCode = answer.status ?? 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(answer.body ?? {}))
      },
    })
    let context: BrowserContext | undefined
    let closePromise: Promise<void> | undefined
    const closeResources = () => {
      if (closePromise) return closePromise
      closePromise = (async () => {
        const attempt = (close: () => Promise<void>) =>
          Promise.resolve().then(close)
        const results = await Promise.allSettled([
          attempt(() => (context ? context.close() : Promise.resolve())),
          attempt(() => server.close()),
        ])
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (failures.length)
          throw new AggregateError(failures, 'Page harness cleanup failed')
      })()
      return closePromise
    }

    try {
      context = await browser.newContext({
        viewport: { width: options.width ?? 1280, height: 900 },
      })
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.origin !== server.origin) return route.abort()
        if (url.pathname === '/app.js')
          return route.fulfill({
            contentType: 'text/javascript',
            body: assets.js,
          })
        if (url.pathname === '/app.css')
          return route.fulfill({ contentType: 'text/css', body: assets.css })
        return route.continue()
      })
      if (options.init) await context.addInitScript(options.init)
      const page = await context.newPage()
      if (options.clock) await page.clock.install()
      await page.goto(server.origin)
      await page.evaluate(
        ([name, route]) =>
          (
            window as unknown as { __mount: (n: string, r: unknown) => void }
          ).__mount(name, route),
        [pageName, options.route ?? {}] as const,
      )
      return {
        page,
        calls: (method, fragment) =>
          server.calls.all.filter(
            (c) => c.method === method && c.url.includes(fragment),
          ).length,
        navigated: () =>
          page.evaluate(() =>
            (
              window as unknown as { __navigated: () => unknown[] }
            ).__navigated(),
          ),
        setRoutes: (next) => void (table = next),
        close: closeResources,
      }
    } catch (error) {
      try {
        await closeResources()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Page harness setup and rollback failed',
          { cause: error },
        )
      }
      throw error
    }
  }
  return {
    open,
    close: async () => {
      await Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
      ])
    },
  }
}

/** Reads the visible text of the page main area. */
export const visibleText = (page: Page) => page.locator('body').innerText()

void readFileSync
