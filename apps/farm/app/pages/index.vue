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
  gap: var(--ops-space-4);
  align-content: start;
  padding: var(--ops-space-5) var(--ops-space-4);
  font-size: var(--ops-text-body);
  line-height: 20px;
}
.home-page :deep(.overview-header) {
  display: grid;
  gap: var(--ops-space-1);
  padding-block-end: var(--ops-space-3);
  border-block-end: 1px solid var(--ops-border);
}
.home-page :deep(.overview-header__eyebrow) {
  margin: 0;
  font-family: var(--ops-font-mono);
  font-size: var(--ops-text-label);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.08em;
  line-height: 16px;
  color: var(--ops-muted);
}
.home-page :deep(h1) {
  margin: 0;
  font-size: var(--ops-text-title);
  line-height: 24px;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.home-page :deep(h1:focus-visible) {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
.panel {
  margin: 0;
  padding: var(--ops-space-4);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-panel);
  color: var(--ops-text);
  min-width: 0;
}
h2 {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  margin: 0 0 var(--ops-space-3);
  padding-block-end: var(--ops-space-2);
  border-block-end: 1px solid var(--ops-border);
  font-size: var(--ops-text-body);
  line-height: 20px;
}
/* Decorative hatch: the heading already says these are unavailable. */
h2::before {
  content: '';
  flex: none;
  inline-size: var(--ops-space-3);
  block-size: var(--ops-space-3);
  border: 1px solid var(--ops-offline);
  background: var(--ops-offline-hatch);
}
.panel p {
  margin: 0 0 var(--ops-space-3);
  line-height: 20px;
  color: var(--ops-muted);
}
.panel p:last-child {
  margin-bottom: 0;
}
.source {
  margin: 0;
  overflow-wrap: anywhere;
}
.source a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  color: var(--ops-action);
}
a:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
</style>
