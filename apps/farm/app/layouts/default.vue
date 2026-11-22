<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ShellNavigation from '../components/shell/ShellNavigation.vue'
import Button from '../components/ui/Button.vue'
import Dialog from '../components/ui/Dialog.vue'
import { selectedFarm } from '../utils/farm-request-guard.ts'
import { listenForAuthInvalidation } from '../utils/auth-invalidation'
import { createShellShortcuts } from '../utils/shell-shortcuts'
import { themeScript, themeStyles } from '../utils/pre-hydration'
import { useStatusSummary } from '../composables/useStatusSummary'
import { useShellRecords } from '../composables/useShellRecords'
import { spoolDisplayTitle } from '../utils/spool-library-format'
import { jobHistoryRow } from '../utils/job-history-view'

useHead({
  script: [{ innerHTML: themeScript }],
  style: [{ innerHTML: themeStyles }],
  meta: [{ name: 'theme-color', content: 'var(--color-surface)' }],
})
const theme = ref('dark')
function changeTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem('farm-theme', theme.value)
  } catch {}
  document.documentElement.dataset.theme = theme.value
  document.documentElement.classList.toggle('dark', theme.value === 'dark')
  document.documentElement.style.colorScheme = theme.value
  const meta = document.querySelector<HTMLMetaElement>('meta[name=theme-color]')
  if (meta)
    meta.content = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-surface')
      .trim()
}
onMounted(() => {
  theme.value =
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const meta = document.querySelector<HTMLMetaElement>('meta[name=theme-color]')
  if (meta)
    meta.content = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-surface')
      .trim()
})

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
const activeFarm = computed(
  () =>
    route.query.farm ??
    (farms.value.length === 1 ? farms.value[0]?.farmId : ''),
)
const selectedFarmId = computed(
  () => selectedFarm(farms.value, route.query.farm)?.farmId,
)
const { summary, failed } = useStatusSummary({
  farmId: () => selectedFarmId.value,
})
const summaryStale = computed(
  () =>
    failed.value ||
    (!!summary.value &&
      (Date.now() - summary.value.generatedAt > 30000 ||
        summary.value.states.some(
          (state) => Date.now() - state.observedAt > 30000,
        ))),
)
const { spools, spoolState, spoolTruncated, latestJob, eventState } =
  useShellRecords(
    () => selectedFarmId.value,
    () => search.value,
    () => query.value,
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
  { to: '/bobinas', label: 'Bobinas' },
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

const modules = [
  {
    to: '/farm',
    label: 'Farm',
    icon: '▦',
    paths: ['/farm', '/impressoras', '/painel'],
  },
  {
    to: '/bobinas',
    label: 'Estoque',
    icon: '◉',
    paths: ['/bobinas', '/spoolman'],
  },
  { to: '/historico', label: 'Cuidado', icon: '◇', paths: ['/historico'] },
  {
    to: '/biblioteca',
    label: 'Criar',
    icon: '▤',
    paths: ['/biblioteca', '/arquivos'],
  },
  {
    to: '/conta',
    label: 'Sistema',
    icon: '⚙',
    paths: ['/conta', '/connectors', '/rede', '/dispositivos', '/integracoes'],
  },
]

const activeModule = computed(() =>
  modules.find((item) =>
    item.paths.some(
      (path) => route.path === path || route.path.startsWith(path + '/'),
    ),
  ),
)
const sectionLinks = computed(() => {
  const paths = activeModule.value?.paths
  return paths
    ? links.value.filter((link) => paths.includes(link.to))
    : links.value
})
const sectionCollapsed = ref(false)
onMounted(() => {
  try {
    sectionCollapsed.value =
      localStorage.getItem('farm-shell-section-collapsed') === 'true'
  } catch {}
})
watch(sectionCollapsed, (collapsed) => {
  try {
    localStorage.setItem('farm-shell-section-collapsed', String(collapsed))
  } catch {}
})
const section = computed(() =>
  links.value.find(
    ({ to }) => to === route.path.split('/').slice(0, 2).join('/'),
  ),
)
const normalize = (value: string) =>
  value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{M}/gu, '')
const paletteGroups = computed(() => {
  const term = normalize(query.value.trim())
  const matches = (value: string) => normalize(value).includes(term)
  return [
    {
      label: 'Páginas',
      items: links.value.filter(({ label }) => matches(label)),
    },
    {
      label: 'Impressoras',
      items: (summary.value?.states ?? [])
        .filter((item) =>
          matches(`${item.displayName ?? ''} ${item.printerKey}`),
        )
        .map((item) => ({
          label: item.displayName || item.printerKey,
          to: `/impressoras/${encodeURIComponent(item.printerKey)}?farm=${encodeURIComponent(selectedFarmId.value ?? '')}`,
        })),
    },
    {
      label: 'Bobinas',
      items: spools.value
        .filter((item) =>
          matches(
            `${spoolDisplayTitle(item)} ${item.id} ${item.filament.material ?? ''} ${item.filament.color_hex ?? ''}`,
          ),
        )
        .map((item) => ({
          label: `${spoolDisplayTitle(item)} · #${item.id}`,
          to: `/bobinas?farm=${encodeURIComponent(selectedFarmId.value ?? '')}&q=${encodeURIComponent(String(item.id))}`,
        })),
    },
  ]
})
const paletteItems = computed(() =>
  paletteGroups.value.flatMap((group) => group.items),
)
const paletteIndex = ref(0)
watch([query, paletteItems], () => {
  paletteIndex.value = 0
})
function paletteKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!paletteItems.value.length) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    paletteIndex.value =
      (paletteIndex.value + delta + paletteItems.value.length) %
      paletteItems.value.length
  } else if (event.key === 'Enter' && paletteItems.value[paletteIndex.value]) {
    event.preventDefault()
    void router.push(paletteItems.value[paletteIndex.value]!.to)
    search.value = false
  }
}
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
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'k' &&
    !event.isComposing
  ) {
    event.preventDefault()
    search.value = true
    return
  }
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
watch(
  () => route.query.farm,
  () => {
    void refreshAccount()
  },
)
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
    const farmId = selectedFarm(page.farms, route.query.farm)?.farmId
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
        aria-keyshortcuts="Control+K Meta+K /"
        @click="search = true"
        >Buscar (Ctrl/⌘ K)</Button
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
      <Button
        :aria-label="
          theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'
        "
        @click="changeTheme"
      >
        {{ theme === 'dark' ? '☀ Claro' : '☾ Escuro' }}
      </Button>
      <details class="vitals">
        <summary>
          Resumo armazenado<span v-if="summary">
            · Imprimindo: {{ summary.counts.printing }} · Atenção:
            {{ summary.counts.paused + summary.counts.error }}</span
          ><span v-else> · Indisponível</span>
          <span v-if="summaryStale"> · Desatualizado</span>
        </summary>
        <p v-if="!summary">Situação indisponível</p>
        <template v-else>
          <p v-if="summaryStale">Dados desatualizados</p>
          <p>
            Imprimindo: {{ summary.counts.printing }} · Atenção:
            {{ summary.counts.paused + summary.counts.error }} · Ociosas:
            {{ summary.counts.idle }} · Offline: {{ summary.counts.offline }}
          </p>
          <p>Próxima conclusão: Não informada</p>
        </template>
      </details>
    </header>
    <aside class="rail" aria-label="Módulos">
      <nav aria-label="Módulos">
        <NuxtLink
          v-for="item in modules"
          :key="item.to"
          :to="item.to"
          :aria-current="
            item.paths.some(
              (path) =>
                route.path === path ||
                (path !== '/' && route.path.startsWith(path + '/')),
            )
              ? 'page'
              : undefined
          "
        >
          <span aria-hidden="true">{{ item.icon }}</span><span>{{
            item.label
          }}</span>
        </NuxtLink>
      </nav>
    </aside>
    <aside class="sidebar">
      <button
        type="button"
        :aria-expanded="!sectionCollapsed"
        @click="sectionCollapsed = !sectionCollapsed"
      >
        {{ activeModule?.label ?? 'Navegação' }}
      </button>
      <ShellNavigation
        v-if="!sectionCollapsed"
        :links="sectionLinks"
        :path="route.path"
      />
    </aside>
    <div id="conteudo-shell" class="content" tabindex="-1">
      <div v-if="section && section.to !== '/'" class="breadcrumbs">
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
      </div>
      <slot />
    </div>
    <footer class="event-strip">
      <template v-if="latestJob"
        >Último trabalho: {{ jobHistoryRow(latestJob).outcome }} ·
        {{ jobHistoryRow(latestJob).filename }} ·
        {{ jobHistoryRow(latestJob).endedAt }}</template
      >
      <template v-else-if="eventState === 'ready'"
        >Nenhum trabalho finalizado registrado</template
      >
      <template v-else-if="eventState === 'loading'"
        >Consultando histórico…</template
      >
      <template v-else>Último evento indisponível</template> ·
      <NuxtLink
        :to="{
          path: '/historico',
          query: selectedFarmId ? { farm: selectedFarmId } : {},
        }"
        >Ver histórico</NuxtLink
      >
    </footer>
    <Dialog v-model="drawer" class="drawer" title="Menu">
      <ShellNavigation
        :links="links"
        :path="route.path"
        @navigate="drawer = false"
      />
    </Dialog>
    <Dialog v-model="search" title="Buscar">
      <label for="shell-search">Buscar páginas, impressoras e bobinas</label>
      <input
        id="shell-search"
        v-model="query"
        type="search"
        autofocus
        @keydown="paletteKey"
      />
      <p v-if="spoolState === 'unavailable'">Busca de bobinas indisponível.</p>
      <p v-if="spoolTruncated">
        Há mais bobinas. Refine a busca para encontrá-las.
      </p>
      <p v-if="!summary">Busca de impressoras indisponível.</p>
      <p v-if="!paletteItems.length" role="status">
        Nenhum resultado encontrado.
      </p>
      <div v-for="group in paletteGroups" :key="group.label">
        <h3 v-if="group.items.length">{{ group.label }}</h3>
        <ul v-if="group.items.length" class="palette-list">
          <li v-for="item in group.items" :key="item.to">
            <NuxtLink
              :to="item.to"
              :class="{ selected: paletteItems[paletteIndex] === item }"
              @click="search = false"
              >{{ item.label }}</NuxtLink
            >
          </li>
        </ul>
      </div>
    </Dialog>
    <Dialog v-model="help" title="Atalhos de teclado">
      <label>
        <input v-model="shortcutsEnabled" type="checkbox" />
        Ativar atalhos de teclado
      </label>
      <ul>
        <li><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> — Buscar</li>
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
  grid-template-columns: 56px 190px minmax(0, 1fr);
  min-height: 100vh;
  color: var(--ops-text);
  background: var(--ops-canvas);
  --ops-canvas: var(--color-surface);
  --ops-panel: var(--color-surface-raised);
  --ops-text: var(--color-text);
  --ops-muted: var(--color-text-muted);
  --ops-border: var(--color-border);
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
.rail {
  background: var(--ops-panel);
  border-right: 1px solid var(--ops-border);
}
.rail nav {
  display: grid;
}
.rail a {
  min-height: 56px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  font-size: 10px;
  text-decoration: none;
  color: var(--ops-text);
}
.rail a span:first-child {
  font-size: 20px;
}
.rail a[aria-current='page'] {
  border-left: 3px solid var(--color-accent);
  background: var(--ops-canvas);
  font-weight: 700;
}
.palette-list {
  list-style: none;
  padding: 0;
}
.palette-list a {
  display: block;
  padding: var(--space-2);
  min-height: 44px;
}
.palette-list a.selected {
  background: var(--surface);
  outline: 2px solid var(--color-focus-ring);
}
.vitals {
  color: var(--ops-text);
}
.vitals summary {
  cursor: pointer;
  min-height: 44px;
  display: flex;
  align-items: center;
}
.event-strip {
  grid-column: 1 / -1;
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--ops-border);
  font-size: var(--font-size-sm);
}
.sidebar,
.breadcrumbs {
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
  .sidebar,
  .rail {
    display: none;
  }
  .drawer-trigger {
    display: inline-flex;
  }
}
</style>
