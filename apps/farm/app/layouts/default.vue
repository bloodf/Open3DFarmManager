<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
  { to: '/historico', label: 'Histórico' },
  { to: '/connectors', label: 'Connectors' },
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

onMounted(async () => {
  try {
    await $fetch('/api/auth/me', { retry: 0, timeout: 10_000 })
    authenticated.value = true
  } catch {
    authenticated.value = false
    currentRole.value = null
    return
  }

  try {
    const page = await $fetch<FarmPage>('/api/farms', {
      query: { limit: 1 },
      retry: 0,
      timeout: 10_000,
    })
    const farmId = page.farms[0]?.farmId
    if (!farmId) return
    const devices = await $fetch<BrowserDevicePage>('/api/browser-devices', {
      query: { farm_id: farmId, limit: 1 },
      retry: 0,
      timeout: 10_000,
    })
    currentRole.value = devices.currentRole
  } catch {
    currentRole.value = null
  }
})
</script>

<template>
  <div>
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
    <label for="theme-choice">Tema</label>
    <select id="theme-choice" v-model="theme" @change="changeTheme">
      <option value="system">Sistema</option>
      <option value="light">Claro</option>
      <option value="dark">Escuro</option>
    </select>
    <slot />
  </div>
</template>

<style scoped>
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 1rem;
}
a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
}
a:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
