<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

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
  { to: '/dispositivos', label: 'Dispositivos do navegador' },
  ...(canApproveConnectors.value
    ? [{ to: '/parear', label: 'Aprovar Connector' }]
    : []),
  { to: '/compatibilidade', label: 'Compatibilidade' },
  ...(isOwner.value ? [{ to: '/convites', label: 'Convidar pessoa' }] : []),
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
