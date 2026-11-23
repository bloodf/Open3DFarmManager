<script setup lang="ts">
import { onMounted, ref } from 'vue'
import OverviewHeader from '../components/overview/OverviewHeader.vue'
import QuickLinks from '../components/overview/QuickLinks.vue'

const header = ref<{ focus: () => void } | null>(null)
onMounted(() => header.value?.focus())

const links = [
  { to: '/farm', label: 'Minha farm' },
  { to: '/connectors', label: 'Consultar Connectors' },
  { to: '/parear', label: 'Aprovar Connector' },
  { to: '/dispositivos', label: 'Dispositivos do navegador' },
  { to: '/entrar', label: 'Entrar' },
  {
    to: '/admin/provedores-entrada',
    label: 'Contas · Provedores de entrada',
  },
  { to: '/convites', label: 'Convidar pessoa' },
  { to: '/sair', label: 'Sair da conta' },
]
</script>

<template>
  <main id="conteudo" class="home-page">
    <OverviewHeader
      ref="header"
      eyebrow="Open3DFarmManager · Desenvolvimento"
      title="Sua farm de impressão, em um só lugar."
    />
    <QuickLinks :links="links" />
    <section class="panel" aria-labelledby="disponibilidade">
      <h2 id="disponibilidade">Recursos ainda indisponíveis</h2>
      <p>
        A conexão com Klipper, Moonraker e Spoolman está em desenvolvimento. O
        pareamento de um Connector depende da configuração segura do serviço e
        da aprovação de um proprietário ou administrador da farm.
      </p>
      <p>
        O estado das impressoras e as câmeras ainda não estão disponíveis. Sem
        conexão, o modo degradado será somente leitura; comandos não estarão
        disponíveis.
      </p>
    </section>
    <p class="source">
      <a href="https://github.com/bloodf/Open3DFarmManager"
        >Acompanhar o desenvolvimento no GitHub</a
      >
    </p>
  </main>
</template>

<style scoped>
.home-page {
  display: grid;
  gap: var(--space-5);
  align-content: start;
}
.panel {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.panel p {
  margin: 0 0 var(--space-3);
}
.panel p:last-child {
  margin-bottom: 0;
}
.source {
  margin: 0;
  overflow-wrap: anywhere;
}
a:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
@media (max-width: 30rem) {
  .panel {
    padding: var(--space-4);
  }
}
</style>
