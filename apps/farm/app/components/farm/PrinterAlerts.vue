<script setup lang="ts">
import { computed } from 'vue'
import {
  FARM_ALERT_META,
  FARM_ALERT_ORDER,
  type FarmAlert,
  type FarmAlertsSummary,
} from '../../utils/farm-alerts.ts'

const props = defineProps<{
  alerts?: FarmAlertsSummary
  chips?: readonly FarmAlert[]
  label?: string
}>()

const activeCounts = computed(() => {
  const summary = props.alerts
  if (!summary) return []
  return FARM_ALERT_ORDER.filter((kind) => summary.counts[kind] > 0).map(
    (kind) => ({
      kind,
      count: summary.counts[kind],
      ...FARM_ALERT_META[kind],
    }),
  )
})
</script>

<template>
  <ul
    v-if="chips !== undefined && chips.length > 0"
    class="alert-chips"
    :aria-label="label ?? 'Alertas da impressora'"
  >
    <li v-for="chip in chips" :key="chip.id" class="alert-chip-item">
      <span
        class="alert-chip"
        :data-alert-kind="chip.kind"
        :style="{ color: `var(--printer-${chip.tone})` }"
      >
        <span aria-hidden="true">{{ chip.icon }}</span>
        <span>{{ chip.label }}</span>
      </span>
    </li>
  </ul>
  <section
    v-else-if="alerts"
    aria-labelledby="farm-alerts-heading"
    class="farm-alerts"
  >
    <h2 id="farm-alerts-heading">
      Alertas da farm
      <span v-if="alerts.total > 0" class="alert-total"
        >({{ alerts.total }})</span
      >
    </h2>
    <p role="status" aria-live="polite" aria-atomic="true">
      {{ alerts.announcement }}
    </p>
    <template v-if="alerts.total > 0">
      <ul class="alert-counts" aria-label="Contagem de alertas por tipo">
        <li
          v-for="entry in activeCounts"
          :key="entry.kind"
          class="alert-count-item"
        >
          <span
            class="alert-chip"
            :data-alert-kind="entry.kind"
            :style="{ color: `var(--printer-${entry.tone})` }"
          >
            <span aria-hidden="true">{{ entry.icon }}</span>
            <span>{{ entry.label }}: {{ entry.count }}</span>
          </span>
        </li>
      </ul>
      <ul class="alert-list" aria-label="Alertas ativos">
        <li
          v-for="alert in alerts.alerts"
          :key="alert.id"
          class="alert-row"
          :data-alert-kind="alert.kind"
        >
          <span
            class="alert-chip"
            :style="{ color: `var(--printer-${alert.tone})` }"
          >
            <span aria-hidden="true">{{ alert.icon }}</span>
            <span>{{ alert.label }}</span>
          </span>
          <span class="alert-message opaque">{{ alert.message }}</span>
          <a :href="alert.href" class="alert-link opaque">
            Ir para {{ alert.targetLabel }}
          </a>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.farm-alerts {
  border: 1px solid currentColor;
  padding: var(--space-4);
  margin-bottom: var(--space-6);
  background: var(--surface-raised);
}
.farm-alerts h2 {
  margin: 0 0 var(--space-2);
}
.alert-counts,
.alert-chips,
.alert-list {
  list-style: none;
  padding: 0;
  margin: var(--space-2) 0 0;
}
.alert-counts,
.alert-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.alert-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: 1px solid currentColor;
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  font-size: var(--type-small);
  font-weight: 600;
}
.alert-list {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.alert-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid currentColor;
}
.alert-message {
  flex: 1 1 14rem;
}
.alert-link {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
}
.alert-link:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
.opaque {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
}
</style>
