<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ShellNavigation from '../components/shell/ShellNavigation.vue'
import Button from '../components/ui/Button.vue'
import Dialog from '../components/ui/Dialog.vue'
import { listenForAuthInvalidation } from '../utils/auth-invalidation'
import { createShellShortcuts } from '../utils/shell-shortcuts'
import { themeScript, themeStyles } from '../utils/pre-hydration'

useHead({
  script: [{ innerHTML: themeScript }],
  style: [{ innerHTML: themeStyles }],
})
const theme = ref('system')
let media: MediaQueryList | undefined
function applyTheme() {
  document.documentElement.dataset.theme =
    theme.value === 'system' ? (media?.matches ? 'dark' : 'light') : theme.value
}
function changeTheme() {
  try {
    localStorage.setItem('farm-theme', theme.value)
  } catch {}
  applyTheme()
}
onMounted(() => {
  try {
    const saved = localStorage.getItem('farm-theme')
    if (saved === 'light' || saved === 'dark') theme.value = saved
  } catch {}
  media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', applyTheme)
  applyTheme()
})
onUnmounted(() => media?.removeEventListener('change', applyTheme))

type FarmPage = { farms: { farmId: string }[] }
type BrowserDevicePage = { currentRole: string }

const route = useRoute()
const router = useRouter()
const farms = ref<FarmPage['farms']>([])
const drawer = ref(false)
const search = ref(false)
const help = ref(false)
const query = ref('')
const shortcutsEnabled = ref(true)
const activeFarm = computed(() =>
  route.path === '/farm'
    ? (route.query.farm ??
      (farms.value.length === 1 ? farms.value[0]?.farmId : ''))
    : '',
)
const authenticated = ref(false)
const currentRole = ref<string | null>(null)
const isOwner = computed(() => currentRole.value === 'owner')
const canApproveConnectors = computed(
  () => currentRole.value === 'owner' || currentRole.value === 'admin',
)

const links = computed(() => [
  { to: '/', label: 'Início' },
  { to: '/farm', label: 'Minha farm' },
  { to: '/impressoras', label: 'Impressoras' },
  { to: '/arquivos', label: 'Arquivos' },
  { to: '/biblioteca', label: 'Biblioteca' },
  { to: '/historico', label: 'Histórico' },
  { to: '/painel', label: 'Painel (TV)' },
  { to: '/connectors', label: 'Connectors' },
  { to: '/rede', label: 'Rede' },
  ...(canApproveConnectors.value
    ? [{ to: '/spoolman', label: 'Spoolman' }]
    : []),
  { to: '/dispositivos', label: 'Dispositivos do navegador' },
  ...(canApproveConnectors.value
    ? [{ to: '/parear', label: 'Aprovar Connector' }]
    : []),
  { to: '/compatibilidade', label: 'Compatibilidade' },
  ...(canApproveConnectors.value
    ? [{ to: '/ui-gallery', label: 'Galeria de componentes' }]
    : []),
  ...(isOwner.value
    ? [
        { to: '/membros', label: 'Membros' },

        { to: '/integracoes', label: 'Integrações' },
        { to: '/bambu-cloud', label: 'Conta Bambu Cloud' },
        { to: '/convites', label: 'Convidar pessoa' },
      ]
    : []),
  ...(authenticated.value ? [{ to: '/conta', label: 'Conta' }] : []),
  { to: '/criar-conta', label: 'Criar conta' },
  { to: '/primeiro-acesso', label: 'Primeiro acesso' },
  { to: '/redefinir-senha', label: 'Redefinir senha' },
  ...(authenticated.value
    ? [{ to: '/sair', label: 'Sair da conta' }]
    : [{ to: '/entrar', label: 'Entrar' }]),
])

const section = computed(() =>
  links.value.find(
    ({ to }) => to === route.path.split('/').slice(0, 2).join('/'),
  ),
)
const results = computed(() => {
  const normalize = (value: string) =>
    value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{M}/gu, '')
  const term = normalize(query.value.trim())
  return links.value.filter(({ label }) => normalize(label).includes(term))
})
const shortcuts = createShellShortcuts((shortcut) => {
  if (shortcut === 'search') search.value = true
  if (shortcut === 'help') help.value = true
  if (shortcut === 'farm') void router.push('/farm')
  if (shortcut === 'library') void router.push('/biblioteca')
})
watch(
  () => route.path,
  () => {
    drawer.value = false
    search.value = false
    help.value = false
  },
)
function switchFarm(event: Event) {
  const select = event.currentTarget
  if (select instanceof HTMLSelectElement && select.value)
    void router.push({ path: '/farm', query: { farm: select.value } })
}

function handleKeydown(event: KeyboardEvent) {
  if (shortcutsEnabled.value) shortcuts(event)
}
let stopAuthListener: (() => void) | undefined
let authRequest: AbortController | undefined
let desktop: MediaQueryList | undefined
function closeDesktopDrawer() {
  if (desktop?.matches) drawer.value = false
}
onMounted(() => {
  desktop = matchMedia('(min-width: 768px)')
  desktop.addEventListener('change', closeDesktopDrawer)
  window.addEventListener('keydown', handleKeydown)
  stopAuthListener = listenForAuthInvalidation(refreshAccount)
  void refreshAccount()
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  desktop?.removeEventListener('change', closeDesktopDrawer)
  stopAuthListener?.()
  authRequest?.abort()
})
async function refreshAccount() {
  authRequest?.abort()
  authRequest = new AbortController()
  const { signal } = authRequest
  authenticated.value = false
  currentRole.value = null
  farms.value = []
  try {
    await $fetch('/api/auth/me', { signal, retry: 0, timeout: 10_000 })
    if (signal.aborted) return
    authenticated.value = true
  } catch {
    return
  }

  try {
    const page = await $fetch<FarmPage>('/api/farms', {
      query: { limit: 20 },
      signal,
      retry: 0,
      timeout: 10_000,
    })
    if (signal.aborted) return
    farms.value = page.farms
    const farmId = page.farms[0]?.farmId
    if (!farmId) return
    const devices = await $fetch<BrowserDevicePage>('/api/browser-devices', {
      query: { farm_id: farmId, limit: 1 },
      signal,
      retry: 0,
      timeout: 10_000,
    })
    if (!signal.aborted) currentRole.value = devices.currentRole
  } catch {
    if (!signal.aborted) currentRole.value = null
  }
}
</script>

<template>
  <div class="shell">
    <a class="skip" href="#conteudo-shell">Pular para o conteúdo</a>
    <header class="toolbar">
      <Button
        class="drawer-trigger"
        aria-haspopup="dialog"
        @click="drawer = true"
        >Menu</Button
      >
      <Button
        aria-haspopup="dialog"
        aria-keyshortcuts="/"
        @click="search = true"
        >Buscar páginas</Button
      >
      <Button aria-haspopup="dialog" aria-keyshortcuts="?" @click="help = true"
        >Atalhos</Button
      >
      <label v-if="farms.length">
        Farm
        <select :value="activeFarm ?? ''" @change="switchFarm">
          <option disabled value="">Selecione uma farm</option>
          <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
            {{ farm.farmId }}
          </option>
        </select>
      </label>
      <label>
        Tema
        <select v-model="theme" @change="changeTheme">
          <option value="system">Sistema</option>
          <option value="light">Claro</option>
          <option value="dark">Escuro</option>
        </select>
      </label>
    </header>
    <aside class="sidebar">
      <nav aria-label="Navegação principal">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          :aria-current="route.path === link.to ? 'page' : undefined"
        >
          {{ link.label }}
        </NuxtLink>
      </nav>
    </aside>
    <div id="conteudo-shell" class="content" tabindex="-1">
      <header v-if="section && section.to !== '/'">
        <nav aria-label="Localização">
          <ol>
            <li><NuxtLink to="/">Início</NuxtLink></li>
            <li v-if="route.path === section.to" aria-current="page">
              {{ section.label }}
            </li>
            <template v-else>
              <li>
                <NuxtLink :to="section.to">{{ section.label }}</NuxtLink>
              </li>
              <li aria-current="page">Detalhes</li>
            </template>
          </ol>
        </nav>
      </header>
      <slot />
    </div>
    <Dialog v-model="drawer" class="drawer" title="Menu">
      <ShellNavigation
        :links="links"
        :path="route.path"
        @navigate="drawer = false"
      />
    </Dialog>
    <Dialog v-model="search" title="Buscar páginas">
      <label>
        Nome da página
        <input v-model="query" type="search" autofocus />
      </label>
      <p v-if="!results.length" role="status">Nenhuma página encontrada.</p>
      <ShellNavigation
        :links="results"
        :path="route.path"
        @navigate="search = false"
      />
    </Dialog>
    <Dialog v-model="help" title="Atalhos de teclado">
      <label>
        <input v-model="shortcutsEnabled" type="checkbox" />
        Ativar atalhos de teclado
      </label>
      <ul>
        <li><kbd>/</kbd> — Buscar páginas</li>
        <li><kbd>g</kbd> depois <kbd>f</kbd> — Minha farm</li>
        <li><kbd>g</kbd> depois <kbd>b</kbd> — Biblioteca</li>
        <li><kbd>?</kbd> — Abrir esta ajuda</li>
      </ul>
    </Dialog>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 14rem minmax(0, 1fr);
}
.toolbar {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface-raised);
}
.toolbar label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  max-inline-size: 100%;
}
select,
input {
  max-inline-size: 100%;
  min-block-size: 2.75rem;
}
.sidebar,
.content > header {
  padding: var(--space-4);
}
.sidebar {
  background: var(--surface-raised);
}
.sidebar nav {
  display: grid;
  gap: var(--space-2);
}
.sidebar a {
  display: flex;
  align-items: center;
  min-block-size: 2.75rem;
  padding-inline: var(--space-2);
  overflow-wrap: anywhere;
}
.sidebar a[aria-current='page'] {
  background: var(--surface);
  font-weight: 700;
}
a:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.content ol {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
  margin: 0;
}
.content li + li::before {
  content: '/';
  margin-inline-end: var(--space-2);
}
.skip {
  position: fixed;
  z-index: 2;
  inset: var(--space-2) auto auto var(--space-2);
  background: var(--surface-raised);
  padding: var(--space-2);
}
.skip:not(:focus) {
  clip-path: inset(50%);
}
.drawer-trigger {
  display: none;
}
.drawer {
  inset: 0 auto 0 0;
  margin: 0;
  inline-size: min(22rem, 100%);
  max-block-size: 100%;
  block-size: 100%;
  box-sizing: border-box;
}
@media (max-width: 767px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }
  .sidebar {
    display: none;
  }
  .drawer-trigger {
    display: inline-flex;
  }
}
</style>
