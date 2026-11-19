<script setup lang="ts">
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import ErrorState from '../ui/ErrorState.vue'
import Skeleton from '../ui/Skeleton.vue'

defineOptions({ name: 'PrintersPageStatus' })
// `started` is true once the first farm read has settled, so the empty state
// never flashes before it.
defineProps<{ started: boolean }>()
const { farmId, farms, pending, error, errorSummary, message } =
  usePrinterSetup()
const { loadFarms } = usePrinterSetupActions()
// The skeleton block announces the first load itself.
const initialLoad = computed(
  () => pending.value && !farmId.value && !farms.value.length,
)
</script>

<template>
  <ErrorState v-if="error" title="Não foi possível carregar as impressoras">
    <p ref="errorSummary" role="alert" tabindex="-1">{{ error }}</p>
    <p>
      <Button @click="loadFarms()">Tentar novamente</Button>
      <NuxtLink to="/entrar">Entrar novamente</NuxtLink>
    </p>
  </ErrorState>
  <p role="status" aria-live="polite">
    {{ pending ? (initialLoad ? '' : 'Aguarde.') : message }}
  </p>
  <div v-if="initialLoad" class="loading" aria-busy="true">
    <p role="status">Carregando as impressoras…</p>
    <Skeleton /><Skeleton /><Skeleton />
  </div>
  <EmptyState
    v-else-if="started && !pending && !error && !farms.length"
    title="Nenhuma farm disponível"
    description="Sua conta ainda não tem acesso a uma farm."
  >
    <NuxtLink to="/parear">Aprovar Connector</NuxtLink>
  </EmptyState>
</template>

<style scoped src="./printer-setup.css"></style>
